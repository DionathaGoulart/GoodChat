import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Hands the service worker the list of files that make up the app shell.
 *
 * public/sw.js caches /assets/* cache-first, but only once something has asked
 * for them — so a browser that installed the worker and then went offline had
 * the cached HTML and nothing it points at. The names are content-hashed, so
 * the worker cannot know them; this writes them in at build time, swapping the
 * `self.__PRECACHE__` expression for the array literal. The placeholder is an
 * expression rather than a bare token because dev serves public/sw.js as it is
 * and registers it anyway (src/main.tsx) — a bare token would be a
 * ReferenceError there and cost the dev worker entirely.
 *
 * Only the entry chunk, what it statically imports, and the stylesheets. A
 * dynamic import is deliberately left out — the emoji data alone is 455KB, and
 * precaching means downloading it for everyone at install whether or not they
 * ever open the picker.
 *
 * The work is split across two hooks because `public/` is copied during the
 * build's own writeBundle: the list is read while the bundle is in hand, and
 * sw.js is rewritten in closeBundle, once the copy has certainly landed.
 */
function precacheShell(): Plugin {
  let shell: string[] = []
  let outDir = 'dist'

  return {
    name: 'goodchat-precache-shell',
    apply: 'build',
    writeBundle(options, bundle) {
      outDir = options.dir ?? outDir
      const files = new Set<string>()
      const visit = (fileName: string): void => {
        const chunk = bundle[fileName]
        if (files.has(fileName) || chunk?.type !== 'chunk') return
        files.add(fileName)
        chunk.imports.forEach(visit)
      }
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk' && item.isEntry) visit(item.fileName)
        if (item.type === 'asset' && item.fileName.endsWith('.css')) files.add(item.fileName)
      }
      shell = [...files].map((fileName) => `/${fileName}`)
    },
    closeBundle() {
      const swPath = join(outDir, 'sw.js')
      const source = readFileSync(swPath, 'utf8')
      const placeholder = 'self.__PRECACHE__ ?? []'
      if (!source.includes(placeholder)) {
        this.error(`sw.js has no \`${placeholder}\` — the shell list has nowhere to go`)
      }
      writeFileSync(swPath, source.replace(placeholder, JSON.stringify(shell)))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), precacheShell()],
  build: {
    // Fonts always ship as files, never as base64 in the CSS. Two reasons:
    // @fontsource splits JetBrains Mono into unicode-range subsets, and the
    // small ones (greek, vietnamese, …) fall under the inline limit — inlined,
    // every visitor downloads subsets they will never render, inside the
    // render-blocking stylesheet. And a data: font would force `font-src data:`
    // into the CSP (worker/src/lib/http.ts), which stays 'self' this way.
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined),
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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

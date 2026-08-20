// Lets Node import the app's modules as they are written.
//
// The SPA is bundled by Vite, so its relative imports have no file extension
// (`./deviceKeys`). Node's ESM resolver requires one. Rather than rewrite every
// import in app/src to suit a test — churn in the shipped code to serve the
// thing checking it — this appends `.ts` when, and only when, the bare
// specifier did not resolve. Nothing else changes: Node 24 strips the types on
// its own.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw error
  }
}

// Resolve hook so raw node can load the extension's .ts files that import
// sibling modules with a .js specifier (pi's own loader does this for us).
// Maps an unresolvable "./x.js" to "./x.ts" when that file exists.
import fs from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND" && specifier.endsWith(".js")) {
      const target = new URL(specifier, context.parentURL ?? "file:///");
      const tsPath = target.pathname.replace(/\.js$/, ".ts");
      if (fs.existsSync(tsPath)) {
        return nextResolve(target.href.replace(/\.js$/, ".ts"), context);
      }
    }
    throw err;
  }
}

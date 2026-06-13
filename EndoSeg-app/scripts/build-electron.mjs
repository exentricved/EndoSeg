// Bundle the Electron main + preload (TypeScript) into CommonJS .cjs files.
// esbuild rewrites the `.js` import specifiers in our TS to the real .ts sources.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  // Keep these external so their runtime binary/asset paths resolve correctly
  // from node_modules (bundling them would break the embedded file paths).
  external: ["electron", "electron-updater", "ffmpeg-static", "ffprobe-static"],
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.cjs",
});

await build({
  ...common,
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.cjs",
});

console.log("electron bundle written to dist-electron/");

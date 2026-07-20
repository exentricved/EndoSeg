import { build } from "esbuild";

const common = {
  bundle: true, platform: "node", format: "cjs", target: "node20",
  sourcemap: true,
  external: ["electron", "better-sqlite3"],
  logLevel: "info",
};

await build({ ...common, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.cjs" });
await build({ ...common, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs" });

console.log("electron bundle written to dist-electron/");

import { spawn } from "node:child_process";
import { createServer } from "vite";
import { build } from "esbuild";
import electron from "electron";

const PORT = 5235;

async function buildMain() {
  const common = {
    bundle: true, platform: "node", format: "cjs", target: "node20",
    external: ["electron", "better-sqlite3"],
    sourcemap: true,
  };
  await build({ ...common, entryPoints: ["electron/main.ts"], outfile: "dist-electron/main.cjs" });
  await build({ ...common, entryPoints: ["electron/preload.ts"], outfile: "dist-electron/preload.cjs" });
}

const server = await createServer({ server: { port: PORT, strictPort: true } });
await server.listen();
const url = `http://localhost:${PORT}`;
console.log(`[endoseg-review] vite dev server on ${url}`);

await buildMain();

const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

child.on("close", async () => {
  await server.close();
  process.exit(0);
});

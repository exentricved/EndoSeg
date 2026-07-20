import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer build. base "./" so the packaged app can load assets via file://.
export default defineConfig({
  root: ".",
  base: "./",
  plugins: [react()],
  server: { port: 5234, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

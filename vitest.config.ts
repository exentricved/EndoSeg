import { defineConfig } from "vitest/config";

// Unit tests cover the pure core + Node disk/crash layers only. Electron-only
// code (electron/*) is excluded — it is exercised by launching the app.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  loadSettings,
  saveSettings,
  applySettings,
} from "./settings.js";

describe("normalizeSettings", () => {
  it("returns defaults for junk input", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings([])).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.frameSampleEvery).toBe(6);
  });

  it("keeps valid fields and rejects invalid ones", () => {
    expect(normalizeSettings({ frameSampleEvery: 10 }).frameSampleEvery).toBe(10);
    expect(normalizeSettings({ frameSampleEvery: 0 }).frameSampleEvery).toBe(6);
    expect(normalizeSettings({ frameSampleEvery: 2.5 }).frameSampleEvery).toBe(6);
    expect(normalizeSettings({ frameSampleEvery: 99999 }).frameSampleEvery).toBe(6);
    expect(normalizeSettings({ gpu: "cpu" }).gpu).toBe("cpu");
    expect(normalizeSettings({ gpu: "metal" }).gpu).toBe("auto");
    expect(normalizeSettings({ libraryDir: "D:/lib" }).libraryDir).toBe("D:/lib");
    expect(normalizeSettings({ libraryDir: "" }).libraryDir).toBeNull();
    expect(normalizeSettings({ libraryDir: null }).libraryDir).toBeNull();
  });
});

describe("applySettings", () => {
  it("patches only provided fields", () => {
    const base = { libraryDir: "D:/lib", frameSampleEvery: 6, gpu: "auto" as const };
    expect(applySettings(base, { frameSampleEvery: 12 })).toEqual({
      libraryDir: "D:/lib",
      frameSampleEvery: 12,
      gpu: "auto",
    });
    expect(applySettings(base, { gpu: "bad" })).toEqual({ ...base, gpu: "auto" });
  });
});

describe("loadSettings / saveSettings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-set-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("loads defaults when no file exists", async () => {
    expect(await loadSettings(path.join(dir, "settings.json"))).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips saved settings", async () => {
    const file = path.join(dir, "settings.json");
    await saveSettings(file, { libraryDir: "D:/x", frameSampleEvery: 8, gpu: "gpu" });
    expect(await loadSettings(file)).toEqual({ libraryDir: "D:/x", frameSampleEvery: 8, gpu: "gpu" });
  });

  it("recovers defaults from a corrupt file", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, "{ not json");
    expect(await loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });
});

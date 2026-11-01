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
    expect(DEFAULT_SETTINGS.phaseFps).toBe(1);
  });

  it("keeps valid fields and rejects invalid ones", () => {
    expect(normalizeSettings({ phaseFps: 2 }).phaseFps).toBe(2);
    expect(normalizeSettings({ phaseFps: 0.5 }).phaseFps).toBe(0.5);
    expect(normalizeSettings({ phaseFps: 0 }).phaseFps).toBe(1);
    expect(normalizeSettings({ phaseFps: 99 }).phaseFps).toBe(1);
    expect(normalizeSettings({ gpu: "cpu" }).gpu).toBe("cpu");
    expect(normalizeSettings({ gpu: "metal" }).gpu).toBe("auto");
    expect(normalizeSettings({ nasRoot: "S:/nas" }).nasRoot).toBe("S:/nas");
    expect(normalizeSettings({ nasRoot: "" }).nasRoot).toBeNull();
    expect(normalizeSettings({ nasRoot: null }).nasRoot).toBeNull();
    expect(normalizeSettings({ exportDir: "E:/out" }).exportDir).toBe("E:/out");
    expect(normalizeSettings({ exportDir: "" }).exportDir).toBeNull();
    // Settings from older versions (name sign-in, every-Nth sampling, per-machine
    // library and clip folders) are dropped.
    expect(
      normalizeSettings({ userName: "A", frameSampleEvery: 4, libraryDir: "D:/lib", rawVideosDir: "R:/raw", phaseExportDir: "R:/out" }),
    ).toEqual(DEFAULT_SETTINGS);
  });
});

describe("applySettings", () => {
  it("patches only provided fields", () => {
    const base = { ...DEFAULT_SETTINGS, nasRoot: "S:/nas" };
    expect(applySettings(base, { phaseFps: 2 })).toEqual({ ...base, phaseFps: 2 });
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
    const saved = { nasRoot: "S:/nas", exportDir: "E:/out", phaseFps: 2, gpu: "gpu" as const };
    await saveSettings(file, saved);
    expect(await loadSettings(file)).toEqual(saved);
  });

  it("recovers defaults from a corrupt file", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, "{ not json");
    expect(await loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });
});

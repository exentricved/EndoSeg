import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings, GpuMode } from "../node/settings.js";
import type { AppInfo, UpdateStatus } from "../shared/ipc.js";

export function SettingsView({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [libraryDir, setLibraryDir] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const unsub = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    setSettings(await window.endoseg.getSettings());
    const ai = await window.endoseg.appInfo();
    setInfo(ai);
    setLibraryDir(ai.libraryDir);
  }, []);

  useEffect(() => {
    void load();
    unsub.current = window.endoseg.onUpdateStatus((s) => setUpdate(s));
    return () => unsub.current?.();
  }, [load]);

  const checkUpdates = useCallback(async () => {
    setUpdate({ state: "checking", message: "Checking…" });
    setUpdate(await window.endoseg.checkForUpdates());
  }, []);

  const patch = useCallback(
    async (p: Partial<Settings>) => {
      const next = await window.endoseg.updateSettings(p);
      setSettings(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
      onChanged();
    },
    [onChanged],
  );

  const chooseDir = useCallback(async () => {
    const state = await window.endoseg.chooseLibraryDir();
    if (state) {
      setLibraryDir(state.baseDir);
      void load();
      onChanged();
    }
  }, [load, onChanged]);

  const chooseExportDir = useCallback(async () => {
    const next = await window.endoseg.chooseExportDir();
    if (next) {
      setSettings(next);
      onChanged();
    }
  }, [onChanged]);

  if (!settings) return <main className="settings"><p className="muted">Loading…</p></main>;

  return (
    <main className="settings">
      <h2>Settings {saved && <span className="saved-tag">saved</span>}</h2>

      <section className="setting-row">
        <div className="setting-label">
          <strong>Library folder</strong>
          <p className="muted">Where all project folders are stored.</p>
        </div>
        <div className="setting-control">
          <code className="path">{libraryDir}</code>
          <button className="secondary" onClick={chooseDir}>Change…</button>
          {settings.libraryDir && (
            <button
              className="secondary"
              onClick={async () => {
                await patch({ libraryDir: null });
                void load();
              }}
            >
              Reset to default
            </button>
          )}
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          <strong>Export folder</strong>
          <p className="muted">
            Where exported datasets are written. Default is each project's 03_export folder;
            a custom folder gets one subfolder per project.
          </p>
        </div>
        <div className="setting-control">
          <code className="path">{settings.exportDir ?? "Inside each project (03_export)"}</code>
          <button className="secondary" onClick={chooseExportDir}>Change…</button>
          {settings.exportDir && (
            <button className="secondary" onClick={() => void patch({ exportDir: null })}>
              Reset to default
            </button>
          )}
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          <strong>Frame sampling</strong>
          <p className="muted">Keep 1 of every N frames extracted from intake video.</p>
        </div>
        <div className="setting-control">
          <label>
            Every
            <input
              type="number"
              min={1}
              max={1000}
              value={settings.frameSampleEvery}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 1000) void patch({ frameSampleEvery: n });
              }}
            />
            th frame
          </label>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          <strong>Duplicate filtering</strong>
          <p className="muted">
            How aggressively near-identical frames are removed in the Dedup stage.
            Higher = more frames treated as duplicates (perceptual-hash distance, 0–64).
          </p>
        </div>
        <div className="setting-control">
          <label>
            Threshold
            <input
              type="number"
              min={0}
              max={64}
              value={settings.dedupThreshold}
              onChange={(e) => {
                if (e.target.value === "") return; // don't treat a cleared field as 0
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0 && n <= 64) void patch({ dedupThreshold: n });
              }}
            />
          </label>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          <strong>Compute</strong>
          <p className="muted">GPU preference for segmentation. "Auto" uses GPU when available.</p>
        </div>
        <div className="setting-control">
          <select
            value={settings.gpu}
            onChange={(e) => void patch({ gpu: e.target.value as GpuMode })}
          >
            <option value="auto">Auto (GPU if available)</option>
            <option value="cpu">CPU only</option>
            <option value="gpu">Require GPU</option>
          </select>
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          <strong>Updates</strong>
          <p className="muted">
            Current version {info ? `v${info.version}` : "…"}. Check for and install new releases.
          </p>
          {update && (
            <p className={`update-status state-${update.state}`}>
              {update.message ?? update.state}
              {update.percent != null && ` ${update.percent}%`}
            </p>
          )}
        </div>
        <div className="setting-control">
          <button className="secondary" onClick={checkUpdates}>Check for updates</button>
        </div>
      </section>
    </main>
  );
}

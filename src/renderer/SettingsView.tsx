import { useCallback, useEffect, useRef, useState } from "react";
import type { Settings, GpuMode } from "../node/settings.js";
import type { AppInfo, UpdateStatus } from "../shared/ipc.js";
import { NAS_FOLDERS, DEFAULT_NAS_ROOT } from "../core/workspaces.js";

export function SettingsView({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [saved, setSaved] = useState(false);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const unsub = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    setSettings(await window.endoseg.getSettings());
    const ai = await window.endoseg.appInfo();
    setInfo(ai);
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

  const chooseNasRoot = useCallback(async () => {
    const next = await window.endoseg.chooseNasRoot();
    if (next) {
      setSettings(next);
      onChanged();
    }
  }, [onChanged]);

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
          <strong>NAS folder</strong>
          <p className="muted">
            The shared folder everyone works in. It holds <code>{NAS_FOLDERS.raw}</code> (source videos, never changed),{" "}
            <code>{NAS_FOLDERS.a1}</code> (first pass) and <code>{NAS_FOLDERS.a2}</code> (second review). Every case,
            with its video, phases, frames, clips and masks, lives in one folder there.
          </p>
        </div>
        <div className="setting-control">
          <code className="path">{settings.nasRoot ?? DEFAULT_NAS_ROOT}</code>
          <button className="secondary" onClick={() => void chooseNasRoot()}>Change…</button>
          {settings.nasRoot && (
            <button className="secondary" onClick={() => void patch({ nasRoot: null })}>
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
          <strong>Segmentation frame rate</strong>
          <p className="muted">Frames per second extracted from every phase except fluoroscopy.</p>
        </div>
        <div className="setting-control">
          <label>
            <input
              type="number"
              min={0.1}
              max={30}
              step={0.5}
              value={settings.phaseFps}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n > 0 && n <= 30) void patch({ phaseFps: n });
              }}
            />
            fps
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

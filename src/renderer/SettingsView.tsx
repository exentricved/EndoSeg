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

  const chooseSettingDir = useCallback(async (key: "rawVideosDir" | "phaseExportDir") => {
    const next = await window.endoseg.chooseSettingDir(key);
    if (next) setSettings(next);
  }, []);

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
          <strong>Raw videos folder</strong>
          <p className="muted">Where the video picker opens.</p>
        </div>
        <div className="setting-control">
          <code className="path">{settings.rawVideosDir ?? "R:\\akshin-ercp-nas\\Raw ERCP Videos (when R: is mapped)"}</code>
          <button className="secondary" onClick={() => void chooseSettingDir("rawVideosDir")}>Change…</button>
          {settings.rawVideosDir && (
            <button className="secondary" onClick={() => void patch({ rawVideosDir: null })}>
              Reset to default
            </button>
          )}
        </div>
      </section>

      <section className="setting-row">
        <div className="setting-label">
          <strong>Phase clips folder</strong>
          <p className="muted">Each phase span is exported as a clip into {"<case>_<phase>"} folders here.</p>
        </div>
        <div className="setting-control">
          <code className="path">{settings.phaseExportDir ?? "R:\\akshin-ercp-nas\\Annotated Videos (when R: is mapped, else Documents)"}</code>
          <button className="secondary" onClick={() => void chooseSettingDir("phaseExportDir")}>Change…</button>
          {settings.phaseExportDir && (
            <button className="secondary" onClick={() => void patch({ phaseExportDir: null })}>
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

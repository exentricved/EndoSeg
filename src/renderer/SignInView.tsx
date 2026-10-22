import { useCallback, useEffect, useState } from "react";
import type { AppInfo, LibraryState } from "../shared/ipc.js";

// Start-up screen: who is working (recorded on intake/export/status changes)
// and confirmation that the shared library folder can actually be written.
export function SignInView({ onSignedIn }: { onSignedIn: (info: AppInfo) => void }) {
  const [name, setName] = useState("");
  const [library, setLibrary] = useState<LibraryState | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setLibrary(await window.endoseg.getLibrary());
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void window.endoseg.getSettings().then((s) => setName((n) => n || s.userName || ""));
    void check();
  }, [check]);

  const changeDir = useCallback(async () => {
    const state = await window.endoseg.chooseLibraryDir();
    if (state) setLibrary(state);
  }, []);

  const ready = name.trim().length > 0 && !!library?.writable && !checking;

  const submit = useCallback(async () => {
    if (!ready) return;
    setBusy(true);
    try {
      onSignedIn(await window.endoseg.startSession(name));
    } finally {
      setBusy(false);
    }
  }, [name, ready, onSignedIn]);

  return (
    <main className="signin">
      <div className="signin-card">
        <div className="brand" style={{ marginBottom: 18 }}>
          <span className="logo" aria-hidden>{"👁"}</span>
          <span className="brand-name">EndoSeg</span>
        </div>

        <label className="signin-label" htmlFor="signin-name">Your name</label>
        <input
          id="signin-name"
          autoFocus
          value={name}
          maxLength={80}
          placeholder="e.g. Ved Akshintala"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        />
        <p className="muted signin-hint">Recorded with every intake, export and status change.</p>

        <div className="signin-label">Library folder</div>
        <div className="signin-lib">
          <code className="path">{library?.baseDir ?? "…"}</code>
          <div className="signin-lib-actions">
            <button className="secondary" onClick={() => void changeDir()} disabled={busy}>Change…</button>
            <button className="secondary" onClick={() => void check()} disabled={checking || busy}>
              {checking ? "Checking…" : "Re-check"}
            </button>
          </div>
        </div>
        {library && !checking && (
          library.writable ? (
            <p className="signin-ok">✓ Folder reachable and writable</p>
          ) : (
            <p className="signin-err">✗ {library.error ?? "Folder can't be used"}</p>
          )
        )}

        <button className="signin-go" onClick={() => void submit()} disabled={!ready || busy}>
          Continue
        </button>
      </div>
    </main>
  );
}

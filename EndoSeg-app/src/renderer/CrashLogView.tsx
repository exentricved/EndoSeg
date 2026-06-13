import { useCallback, useEffect, useState } from "react";

// Troubleshooting page: list crash incidents, show full text, copy / open folder.
export function CrashLogView() {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    const list = await window.endoseg.listCrashes();
    setFiles(list);
    if (list.length && !list.includes(selected ?? "")) setSelected(list[0]);
  }, [selected]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selected) {
      setText("");
      return;
    }
    void window.endoseg.readCrash(selected).then((t) => setText(t ?? "(could not read report)"));
  }, [selected]);

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <main className="crashlog">
      <div className="crashlog-toolbar">
        <h2>Troubleshooting & crash log</h2>
        <div className="toolbar-actions">
          <button className="secondary" onClick={() => void reload()}>
            Refresh
          </button>
          <button className="secondary" onClick={() => void window.endoseg.openCrashFolder()}>
            Open logs folder
          </button>
          <button onClick={() => void copy()} disabled={!text}>
            {copied ? "Copied!" : "Copy report"}
          </button>
        </div>
      </div>

      {files.length === 0 ? (
        <div className="empty">
          <p>No crash reports. 🎉</p>
          <p className="muted">
            If something goes wrong, a report appears here that you can copy and paste for support.
          </p>
        </div>
      ) : (
        <div className="crashlog-body">
          <ul className="crashlog-list">
            {files.map((f) => (
              <li
                key={f}
                className={f === selected ? "active" : ""}
                onClick={() => setSelected(f)}
              >
                {f.replace(/\.txt$/, "")}
              </li>
            ))}
          </ul>
          <pre className="crashlog-text">{text}</pre>
        </div>
      )}
    </main>
  );
}

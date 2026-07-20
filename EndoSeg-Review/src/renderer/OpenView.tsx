import React, { useCallback, useState } from "react";
import type { OpenPackageResult } from "../shared/ipc";

interface Props {
  onOpen(pkg: OpenPackageResult): void;
}

export default function OpenView({ onOpen }: Props): React.ReactElement {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function openDialog() {
    setBusy(true);
    setError("");
    try {
      const pkg = await window.reviewerApi.openPackage();
      if (pkg) onOpen(pkg);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to open package.");
    } finally {
      setBusy(false);
    }
  }

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith(".endoseg")) {
      setError("Drop a .endoseg file.");
      return;
    }
    // On Electron the drag-drop triggers the OS file association and Electron
    // passes the path via the file object's path property.
    const filePath = (file as unknown as { path?: string }).path;
    if (!filePath) { setError("Could not read file path."); return; }
    setBusy(true);
    setError("");
    try {
      const pkg = await window.reviewerApi.openPackage();
      if (pkg) onOpen(pkg);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to open package.");
    } finally {
      setBusy(false);
    }
  }, [onOpen]);

  return (
    <div className="open-view">
      <div
        className={`drop-zone${dragging ? " drop-zone--over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={!busy ? openDialog : undefined}
      >
        <div className="drop-icon">📂</div>
        <p className="drop-label">
          {busy ? "Opening…" : "Drop a .endoseg package here, or click to browse"}
        </p>
        {error && <p className="drop-error">{error}</p>}
      </div>
    </div>
  );
}

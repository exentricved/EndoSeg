/**
 * KeypointModal — small dialog shown when placing a named landmark.
 * Asks for keypoint name (from KEYPOINT_NAMES) and optional note (used for VASCULAR_MARK).
 */

import { useEffect, useRef, useState } from "react";
import { KEYPOINT_NAMES, type KeypointName } from "../ercpClasses";

interface KeypointModalProps {
  defaultName?: KeypointName;
  onSubmit: (name: KeypointName, note: string | undefined) => void;
  onCancel: () => void;
}

export function KeypointModal({ defaultName, onSubmit, onCancel }: KeypointModalProps) {
  const [name, setName] = useState<KeypointName>(defaultName ?? KEYPOINT_NAMES[0]);
  const [note, setNote] = useState("");
  const selectRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    onSubmit(name, name === "VASCULAR_MARK" ? note.trim() || undefined : undefined);
  };

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        style={{
          background: "#1f2937", color: "#fff",
          border: "1px solid #374151", borderRadius: 8,
          padding: 16, width: 300, display: "flex", flexDirection: "column", gap: 12,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 14 }}>Place keypoint</div>
        <div>
          <label style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,0.7)", marginBottom: 4 }}>
            Landmark name
          </label>
          <select
            ref={selectRef}
            value={name}
            onChange={(e) => setName(e.target.value as KeypointName)}
            style={{
              width: "100%", padding: "6px 8px", fontSize: 13,
              background: "rgba(255,255,255,0.05)", color: "#fff",
              border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4,
            }}
          >
            {KEYPOINT_NAMES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        {name === "VASCULAR_MARK" && (
          <div>
            <label style={{ display: "block", fontSize: 11, color: "rgba(255,255,255,0.7)", marginBottom: 4 }}>
              Description (optional)
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              style={{
                width: "100%", boxSizing: "border-box",
                padding: "6px 8px", fontSize: 13,
                background: "rgba(255,255,255,0.05)", color: "#fff",
                border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, resize: "vertical",
              }}
            />
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              padding: "6px 12px", fontSize: 12, color: "rgba(255,255,255,0.75)",
              background: "transparent", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 4, cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            style={{
              padding: "6px 12px", fontSize: 12, fontWeight: 700, color: "#fff",
              background: "#A78BFA", border: "1px solid #A78BFA", borderRadius: 4, cursor: "pointer",
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

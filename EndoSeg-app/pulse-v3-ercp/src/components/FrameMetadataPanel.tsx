/**
 * FrameMetadataPanel — per-frame procedural / deformation / quality / usability flags.
 *
 * usable_for_* fields are auto-derived from quality_flags + INSTRUMENT_MASK overlap,
 * unless the corresponding manual_override flag is set.
 */

import {
  PROCEDURAL_STATES,
  DEFORMATION_STATES,
  QUALITY_FLAGS,
  type FrameMetadata,
  type ProceduralState,
  type DeformationState,
  type QualityFlag,
} from "../ercpClasses";

interface FrameMetadataPanelProps {
  metadata: FrameMetadata;
  computedUsableDepth: boolean;
  computedUsableSeg: boolean;
  onChange: (patch: Partial<FrameMetadata>) => void;
  onClose?: () => void;
}

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "rgba(255,255,255,0.7)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};
const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  color: "#fff",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 4,
  outline: "none",
  boxSizing: "border-box",
};

export function FrameMetadataPanel({
  metadata,
  computedUsableDepth,
  computedUsableSeg,
  onChange,
  onClose,
}: FrameMetadataPanelProps) {
  const effectiveDepth = metadata.usable_for_depth_manual_override
    ? metadata.usable_for_depth_training
    : computedUsableDepth;
  const effectiveSeg = metadata.usable_for_segmentation_manual_override
    ? metadata.usable_for_segmentation_training
    : computedUsableSeg;

  const toggleFlag = (flag: QualityFlag) => {
    const has = metadata.frame_quality_flags.includes(flag);
    const next = has
      ? metadata.frame_quality_flags.filter(f => f !== flag)
      : [...metadata.frame_quality_flags, flag];
    onChange({ frame_quality_flags: next });
  };

  return (
    <div style={{
      padding: 12,
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: 6,
      background: "rgba(15,23,42,0.92)",
      color: "#fff",
      display: "flex",
      flexDirection: "column",
      gap: 12,
      minWidth: 280,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>Frame metadata</div>
        {onClose && (
          <button onClick={onClose} style={{
            padding: "2px 8px", fontSize: 11, color: "#94a3b8",
            background: "transparent", border: "1px solid #334155", borderRadius: 4, cursor: "pointer",
          }}>Close</button>
        )}
      </div>

      {/* Procedural state */}
      <div>
        <label style={LABEL_STYLE}>Procedural state</label>
        <select
          value={metadata.procedural_state}
          onChange={(e) => onChange({ procedural_state: e.target.value as ProceduralState })}
          style={INPUT_STYLE}
        >
          <option value="">(unset)</option>
          {PROCEDURAL_STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Deformation state */}
      <div>
        <label style={LABEL_STYLE}>Deformation state</label>
        <select
          value={metadata.deformation_state}
          onChange={(e) => onChange({ deformation_state: e.target.value as DeformationState })}
          style={INPUT_STYLE}
        >
          <option value="">(unset)</option>
          {DEFORMATION_STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Quality flags */}
      <div>
        <label style={LABEL_STYLE}>Quality flags</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {QUALITY_FLAGS.map(flag => (
            <label key={flag} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={metadata.frame_quality_flags.includes(flag)}
                onChange={() => toggleFlag(flag)}
              />
              <span>{flag}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Usable for depth */}
      <div style={{ padding: 8, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={effectiveDepth}
            disabled={!metadata.usable_for_depth_manual_override}
            onChange={(e) => onChange({ usable_for_depth_training: e.target.checked })}
          />
          <span style={{ fontWeight: 600 }}>Usable for depth training</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, marginTop: 4, color: "rgba(255,255,255,0.7)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={metadata.usable_for_depth_manual_override}
            onChange={(e) => {
              if (e.target.checked) {
                onChange({ usable_for_depth_manual_override: true, usable_for_depth_training: effectiveDepth });
              } else {
                onChange({ usable_for_depth_manual_override: false, usable_for_depth_training: computedUsableDepth });
              }
            }}
          />
          <span>manual override</span>
          <span style={{ fontSize: 10, opacity: 0.6, marginLeft: "auto" }}>
            auto: {computedUsableDepth ? "yes" : "no"}
          </span>
        </label>
      </div>

      {/* Usable for segmentation */}
      <div style={{ padding: 8, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={effectiveSeg}
            disabled={!metadata.usable_for_segmentation_manual_override}
            onChange={(e) => onChange({ usable_for_segmentation_training: e.target.checked })}
          />
          <span style={{ fontWeight: 600 }}>Usable for segmentation training</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, marginTop: 4, color: "rgba(255,255,255,0.7)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={metadata.usable_for_segmentation_manual_override}
            onChange={(e) => {
              if (e.target.checked) {
                onChange({ usable_for_segmentation_manual_override: true, usable_for_segmentation_training: effectiveSeg });
              } else {
                onChange({ usable_for_segmentation_manual_override: false, usable_for_segmentation_training: computedUsableSeg });
              }
            }}
          />
          <span>manual override</span>
          <span style={{ fontSize: 10, opacity: 0.6, marginLeft: "auto" }}>
            auto: {computedUsableSeg ? "yes" : "no"}
          </span>
        </label>
      </div>
    </div>
  );
}

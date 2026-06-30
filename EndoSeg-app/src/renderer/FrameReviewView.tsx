import { useEffect, useState } from "react";
import type { FrameReviewResult } from "../shared/ipc.js";

export function FrameReviewView({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [review, setReview] = useState<FrameReviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "kept" | "dropped">("all");

  useEffect(() => {
    setLoading(true);
    window.endoseg
      .getFrameReview(projectId)
      .then((r) => {
        setReview(r);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [projectId]);

  const items = review?.items ?? [];
  const visible = filter === "all" ? items : items.filter((it) => (filter === "kept" ? it.kept : !it.kept));

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#0d1520",
        color: "#e4e9f0",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 14px",
          borderBottom: "1px solid #1e2d40",
          flexShrink: 0,
        }}
      >
        <button className="secondary" onClick={onBack}>
          ← Back
        </button>
        <strong>Frame Review</strong>
        {review && (
          <>
            <span style={{ color: "#4ade80", fontSize: 12 }}>✓ {review.kept} kept</span>
            <span style={{ color: "#f87171", fontSize: 12 }}>✕ {review.dropped} dropped</span>
            <span style={{ color: "#475569", fontSize: 12 }}>of {review.total} total</span>
          </>
        )}
        <div style={{ flex: 1 }} />
        {/* Filter buttons */}
        <div style={{ display: "flex", gap: 4 }}>
          {(["all", "kept", "dropped"] as const).map((f) => (
            <button
              key={f}
              className={filter === f ? "" : "secondary"}
              onClick={() => setFilter(f)}
              style={{ fontSize: 11, padding: "2px 10px", textTransform: "capitalize" }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {loading && (
          <div style={{ padding: 32, color: "#475569", textAlign: "center" }}>
            Loading frame review…
          </div>
        )}
        {!loading && !review && (
          <div style={{ padding: 32, color: "#f87171", textAlign: "center" }}>
            No dedup report found. Run the dedup stage first.
          </div>
        )}
        {!loading && review && visible.length === 0 && (
          <div style={{ padding: 32, color: "#475569", textAlign: "center" }}>
            No frames match the current filter.
          </div>
        )}
        {!loading && visible.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 10,
            }}
          >
            {visible.map((item) => (
              <FrameCard key={item.file} item={item} index={items.indexOf(item)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FrameCard({
  item,
  index,
}: {
  item: FrameReviewResult["items"][number];
  index: number;
}) {
  const border = item.kept ? "2px solid #22c55e" : "2px solid #ef4444";
  return (
    <div
      title={
        item.kept
          ? `Frame ${index + 1} — kept`
          : `Frame ${index + 1} — dropped (distance ${item.distance ?? "?"} from ${item.representative})`
      }
      style={{
        border,
        borderRadius: 6,
        overflow: "hidden",
        background: "#0a1220",
        position: "relative",
        cursor: "default",
      }}
    >
      <img
        src={item.url}
        loading="lazy"
        decoding="async"
        style={{
          width: "100%",
          aspectRatio: "16/9",
          objectFit: "cover",
          display: "block",
          opacity: item.kept ? 1 : 0.45,
        }}
      />
      {/* Label overlay */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          background: "rgba(0,0,0,0.62)",
          padding: "3px 6px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 10,
        }}
      >
        <span style={{ color: "#6b7e94" }}>{index + 1}</span>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "#8899aa",
          }}
        >
          {item.file.replace(/\.[^.]+$/, "")}
        </span>
        <span style={{ color: item.kept ? "#4ade80" : "#f87171", fontWeight: 700 }}>
          {item.kept ? "✓" : "✕"}
        </span>
        {!item.kept && item.distance !== undefined && (
          <span style={{ color: "#64748b" }}>d={item.distance}</span>
        )}
      </div>
    </div>
  );
}

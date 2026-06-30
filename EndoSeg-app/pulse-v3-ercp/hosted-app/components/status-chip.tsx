function toneForValue(value: string) {
  if (value === "urgent") return "danger";
  if (value === "priority") return "pending";
  if (value === "routine") return "ready";
  if (value === "pdf" || value === "image") return "ready";
  if (value === "text" || value === "json") return "active";
  if (value.includes("adjudication")) return "danger";
  if (value.startsWith("in_review")) return "active";
  if (value.includes("failed") || value.includes("cancelled")) return "danger";
  if (value.includes("returned")) return "danger";
  if (value.includes("completed") || value.includes("submitted") || value.includes("finalized")) return "completed";
  if (value.includes("opened") || value.includes("processing") || value.includes("progress")) return "active";
  if (value.includes("review") || value.includes("ready")) return "ready";
  if (value.includes("assigned") || value.includes("draft") || value.includes("uploaded") || value.includes("awaiting")) {
    return "pending";
  }
  return "archived";
}

export function StatusChip({ value }: { value: string }) {
  return <span className={`chip ${toneForValue(value)}`}>{value.replaceAll("_", " ")}</span>;
}

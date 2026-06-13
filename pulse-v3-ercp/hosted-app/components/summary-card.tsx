export function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ready" | "active" | "completed" | "pending";
}) {
  return (
    <article className="card">
      <p className="eyebrow">{label}</p>
      <div className="summary-value">{value}</div>
      <span className={`chip ${tone}`}>{tone}</span>
    </article>
  );
}

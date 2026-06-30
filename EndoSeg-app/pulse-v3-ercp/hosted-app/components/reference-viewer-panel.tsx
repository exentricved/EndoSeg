import type { HostedCaseReference } from "@/lib/domain/models";

export function ReferenceViewerPanel({
  caseId,
  reference,
}: {
  caseId: string;
  reference: HostedCaseReference;
}) {
  const referenceHref = `/api/cases/${caseId}/references/${reference.id}`;

  return (
    <section className="card">
      <p className="eyebrow">Read-only reference</p>
      <h3>{reference.title}</h3>
      <p className="muted">{reference.sourceName}</p>

      {reference.referenceKind === "pdf" ? (
        <div className="row" style={{ marginBottom: 12 }}>
          <a
            className="button primary"
            href={referenceHref}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open report PDF
          </a>
        </div>
      ) : null}

      {reference.referenceKind === "text" || reference.referenceKind === "json" ? (
        <pre
          style={{
            margin: 0,
            padding: 16,
            borderRadius: 16,
            background: "#f7f2ea",
            border: "1px solid #ddd3c3",
            whiteSpace: "pre-wrap",
            overflowX: "auto",
          }}
        >
          {reference.textContent || ""}
        </pre>
      ) : null}

      {reference.referenceKind === "pdf" && reference.storageKey ? (
        <iframe
          title={reference.title}
          src={referenceHref}
          style={{
            width: "100%",
            minHeight: 520,
            border: "1px solid #ddd3c3",
            borderRadius: 16,
            background: "#fff",
          }}
        />
      ) : null}

      {reference.referenceKind === "image" && reference.storageKey ? (
        <img
          alt={reference.title}
          src={referenceHref}
          style={{
            maxWidth: "100%",
            borderRadius: 16,
            border: "1px solid #ddd3c3",
            background: "#fff",
          }}
        />
      ) : null}
    </section>
  );
}

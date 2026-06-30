import { requireRole } from "@/lib/auth/session";
import { AdminIngestionPanel } from "@/components/admin-ingestion-panel";

import { validateCasePackageAction } from "./actions";

type AdminUploadPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminUploadPage({ searchParams }: AdminUploadPageProps) {
  await requireRole(["admin"]);
  const params = (await searchParams) || {};

  const validated = typeof params.validated === "string" ? params.validated : "";
  const manifest = typeof params.manifest === "string" ? params.manifest : "";
  const assets = typeof params.assets === "string" ? params.assets : "";
  const caseKey = typeof params.caseKey === "string" ? params.caseKey : "";
  const displayCaseId = typeof params.displayCaseId === "string" ? params.displayCaseId : "";
  const message = typeof params.message === "string" ? params.message : "";

  return (
    <>
      <section className="hero-card">
        <p className="eyebrow">Admin intake</p>
        <h2>Ingest case media</h2>
        <p className="muted">
          Create hosted cases from ordered frame images or from video uploads that are converted into review-ready frame sets.
        </p>
      </section>

      <AdminIngestionPanel />

      <section className="split">
        <aside className="card">
          <h3>Ingestion guidance</h3>
          <div className="stack">
            <div className="notice">
              Image uploads preserve the selected frame order. Video uploads use a configurable
              extraction interval before the case is created.
            </div>
            <div className="meta-item">
              <span className="meta-label">Reviewer-facing reports</span>
              Attach PDF reports when available so case detail and the review workspace can open
              them directly.
            </div>
          </div>
        </aside>

        <aside className="card">
          <h3>Advanced manifest import</h3>
          <details>
            <summary>Use the legacy manifest package flow</summary>
            <form className="form-grid" action={validateCasePackageAction} style={{ marginTop: 16 }}>
              <div className="field">
                <label htmlFor="manifest">Manifest JSON</label>
                <input id="manifest" name="manifest" type="file" accept=".json,application/json" required />
              </div>
              <div className="field">
                <label htmlFor="assets">Frames and optional report files</label>
                <input
                  id="assets"
                  name="assets"
                  type="file"
                  accept="image/*,.pdf,application/pdf"
                  multiple
                  required
                />
              </div>
              <div className="row">
                <button className="button ghost" type="submit">
                  Import manifest package
                </button>
              </div>
            </form>
          </details>
        </aside>
      </section>

      {validated ? (
        <section className={`notice ${validated === "1" ? "success" : "warning"}`}>
          <strong>{validated === "1" ? "Case created." : "Package rejected."}</strong>
          <div style={{ marginTop: 6 }}>
            Manifest: {manifest || "missing"} | Assets: {assets || "0"} | Case key: {caseKey || "none"}
          </div>
          <div style={{ marginTop: 6 }}>{message || "No validation message returned."}</div>
          {validated === "1" && displayCaseId ? (
            <div style={{ marginTop: 10 }}>
              Created hosted case <strong>{displayCaseId}</strong>.
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <div className="page-shell">
      <main className="content">
        <section className="hero-card">
          <p className="eyebrow">Access denied</p>
          <h2>You do not have permission to open this hosted route.</h2>
          <p className="muted">
            The hosted shell enforces role and assignment boundaries separately from the
            existing local annotator.
          </p>
          <div className="row" style={{ marginTop: 12 }}>
            <Link className="button primary" href="/sign-in">
              Return to sign in
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}

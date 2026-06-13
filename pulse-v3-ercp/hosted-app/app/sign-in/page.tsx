import { signInAction } from "@/lib/auth/actions";
import { OIDC_PLACEHOLDER_MESSAGE } from "@/lib/auth/provider";
import { listDevUsers } from "@/lib/server/mock-store";

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = (await searchParams) || {};
  const next = typeof params.next === "string" ? params.next : "";
  const error = typeof params.error === "string" ? params.error : "";
  const users = await listDevUsers();
  const activeUsers = users.filter((user) => user.status === "active");
  const disabledUsers = users.filter((user) => user.status === "disabled");
  const defaultUserId = activeUsers[0]?.id || "";

  return (
    <div className="page-shell">
      <div className="auth-page">
        <section className="auth-shell">
          <section className="auth-card hero-card">
            <div>
              <p className="eyebrow">Hosted Review Platform</p>
              <h1 className="auth-title">PULSE v3 – Liver</h1>
              <p className="muted">
                Multi-reviewer annotation workflow for liver EUS ground-truth.
              </p>
            </div>

            {error ? (
              <div className="notice warning">
                {error}
              </div>
            ) : null}

            <form action={signInAction} className="form-grid">
              <input type="hidden" name="next" value={next} />
              <div className="field">
                <label htmlFor="userId">Sign in as</label>
                <select defaultValue={defaultUserId} id="userId" name="userId">
                  <optgroup label="Admin">
                    {activeUsers
                      .filter((u) => u.primaryRole === "admin")
                      .map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.displayName} — {user.email}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Reviewer">
                    {activeUsers
                      .filter((u) => u.primaryRole === "reviewer")
                      .map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.displayName} — {user.email}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Adjudicator">
                    {activeUsers
                      .filter((u) => u.primaryRole === "adjudicator")
                      .map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.displayName} — {user.email}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </div>
              <button className="button primary auth-submit-btn" type="submit">
                Sign in
              </button>
            </form>

            {disabledUsers.length ? (
              <div className="auth-support-block">
                <h3>Unavailable</h3>
                <div className="stack">
                  {disabledUsers.map((user) => (
                    <div key={user.id} className="auth-user-row disabled">
                      <div>
                        <strong>{user.displayName}</strong>
                        <div className="muted">{user.email}</div>
                      </div>
                      <span className="chip archived">{user.primaryRole}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="auth-support-block">
              <p className="muted auth-env-note">{OIDC_PLACEHOLDER_MESSAGE}</p>
            </div>
          </section>
        </section>
      </div>
    </div>
  );
}

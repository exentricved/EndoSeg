import type { HostedUser } from "@/lib/domain/models";

export function UserIdentity({
  user,
  fallback,
  compact = false,
}: {
  user: HostedUser | null;
  fallback?: string;
  compact?: boolean;
}) {
  if (!user) {
    return <span>{fallback || "Unknown user"}</span>;
  }

  return (
    <div className={`user-identity${compact ? " compact" : ""}`}>
      <div className="user-identity-primary">
        <strong>{user.displayName}</strong>
        {user.status === "disabled" ? (
          <span style={{ marginLeft: 8 }}>
            <span className="chip archived">disabled</span>
          </span>
        ) : null}
      </div>
      <div className="muted user-identity-secondary">{user.email}</div>
    </div>
  );
}

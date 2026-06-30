import Link from "next/link";

import { SignOutForm } from "@/components/sign-out-form";
import { getDefaultRouteForRole } from "@/lib/auth/provider";
import type { HostedSession } from "@/lib/auth/session";

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className="nav-pill" href={href}>
      {label}
    </Link>
  );
}

export function HostedTopNav({ session }: { session: HostedSession }) {
  const homeHref = getDefaultRouteForRole(session.role);

  return (
    <header className="topbar">
      <div>
        <div className="brand-kicker">Hosted Review Platform</div>
        <div className="brand-title">PULSE v3 - Liver</div>
      </div>

      <div className="nav-links">
        <NavLink href={homeHref} label="Home" />
        {session.role === "admin" ? (
          <>
            <NavLink href="/admin/cases" label="Admin cases" />
            <NavLink href="/admin/upload" label="Upload package" />
          </>
        ) : null}
        {session.role === "reviewer" ? (
          <NavLink href="/reviewer/dashboard" label="Reviewer queue" />
        ) : null}
        {session.role === "adjudicator" ? (
          <NavLink href="/adjudicator/dashboard" label="Adjudicator dashboard" />
        ) : null}
        <div className="nav-pill nav-pill-static">
          <span className="nav-identity-name">{session.displayName}</span>
          <span className="nav-identity-role">{session.role}</span>
        </div>
        <SignOutForm />
      </div>
    </header>
  );
}

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AUTH_MODE, SESSION_COOKIE_NAME } from "@/lib/auth/provider";
import type { HostedRole } from "@/lib/domain/models";

export type HostedSession = {
  userId: string;
  email: string;
  displayName: string;
  role: HostedRole;
};

function encodeSession(session: HostedSession) {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

function decodeSession(raw: string): HostedSession | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed.userId === "string" &&
      typeof parsed.email === "string" &&
      typeof parsed.displayName === "string" &&
      (parsed.role === "admin" || parsed.role === "reviewer" || parsed.role === "adjudicator")
    ) {
      return parsed as HostedSession;
    }
  } catch {
    return null;
  }

  return null;
}

export async function getSession(): Promise<HostedSession | null> {
  if (AUTH_MODE !== "mock") {
    return null;
  }

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;
  return decodeSession(raw);
}

export async function requireSession() {
  const session = await getSession();
  if (!session) {
    redirect("/sign-in");
  }
  return session;
}

export async function requireRole(allowedRoles: HostedRole[]) {
  const session = await requireSession();
  if (!allowedRoles.includes(session.role)) {
    redirect("/forbidden");
  }
  return session;
}

export async function setMockSession(session: HostedSession) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

export async function clearMockSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

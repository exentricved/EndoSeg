"use server";

import { redirect } from "next/navigation";

import { getDefaultRouteForRole } from "@/lib/auth/provider";
import { clearMockSession, getSession, setMockSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/server/audit";
import { findDevUserById } from "@/lib/server/mock-store";

function safeNextPath(nextValue: string | null) {
  if (!nextValue) return null;
  return nextValue.startsWith("/") ? nextValue : null;
}

export async function signInAction(formData: FormData) {
  const userId = String(formData.get("userId") || "");
  const next = safeNextPath(typeof formData.get("next") === "string" ? String(formData.get("next")) : null);
  const user = await findDevUserById(userId);

  if (!user) {
    redirect("/sign-in?error=Unknown+mock+user");
  }

  if (user.status !== "active") {
    redirect("/sign-in?error=User+account+is+disabled");
  }

  await setMockSession({
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.primaryRole,
  });

  await recordAuditEvent({
    actorUserId: user.id,
    objectType: "auth_session",
    objectId: user.id,
    action: "mock_sign_in",
    payload: { role: user.primaryRole },
  });

  redirect(next || getDefaultRouteForRole(user.primaryRole));
}

export async function signOutAction() {
  const session = await getSession();

  if (session) {
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "auth_session",
      objectId: session.userId,
      action: "mock_sign_out",
    });
  }

  await clearMockSession();
  redirect("/sign-in");
}

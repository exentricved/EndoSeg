import type { HostedRole } from "@/lib/domain/models";

export type AuthMode = "mock" | "oidc";

export const AUTH_MODE: AuthMode = process.env.AUTH_MODE === "oidc" ? "oidc" : "mock";
export const SESSION_COOKIE_NAME = "annotateeus_hosted_session";
export const OIDC_PLACEHOLDER_MESSAGE =
  "Enterprise sign-in is not connected in this environment yet. Use the current workspace selector for local access.";

export function getDefaultRouteForRole(role: HostedRole) {
  switch (role) {
    case "admin":
      return "/admin/cases";
    case "adjudicator":
      return "/adjudicator/dashboard";
    case "reviewer":
    default:
      return "/reviewer/dashboard";
  }
}

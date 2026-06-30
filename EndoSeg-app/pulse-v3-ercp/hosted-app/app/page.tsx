import { redirect } from "next/navigation";

import { getDefaultRouteForRole } from "@/lib/auth/provider";
import { getSession } from "@/lib/auth/session";

export default async function HomePage() {
  const session = await getSession();

  if (!session) {
    redirect("/sign-in");
  }

  redirect(getDefaultRouteForRole(session.role));
}

import { HostedTopNav } from "@/components/hosted-top-nav";
import { requireSession } from "@/lib/auth/session";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

  return (
    <div className="page-shell">
      <HostedTopNav session={session} />
      <main className="content">{children}</main>
    </div>
  );
}

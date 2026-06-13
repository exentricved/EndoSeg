import { redirect } from "next/navigation";

type LegacyHostedReviewPageProps = {
  params: Promise<{ assignmentId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LegacyHostedReviewPage({
  params,
  searchParams,
}: LegacyHostedReviewPageProps) {
  const { assignmentId } = await params;
  const query = (await searchParams) || {};
  const paramsOut = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      paramsOut.set(key, value);
    }
  }

  const suffix = paramsOut.toString() ? `?${paramsOut.toString()}` : "";
  redirect(`/review/${assignmentId}${suffix}`);
}

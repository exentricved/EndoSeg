"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import App from "../../src/App";
import type {
  HostedAnnotatorManifest,
  HostedAnnotatorOutput,
} from "../../src/hostedReviewContract";

type HostedReviewShellProps = {
  manifest: HostedAnnotatorManifest;
  caseDetailHref: string;
};

export function HostedReviewShell({ manifest, caseDetailHref }: HostedReviewShellProps) {
  const router = useRouter();
  const openLoggedRef = useRef(false);
  const [submissionState, setSubmissionState] = useState<"idle" | "submitting" | "submitted" | "error">("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    if (openLoggedRef.current) return;
    openLoggedRef.current = true;
    void (async () => {
      await fetch(`/api/reviews/${manifest.assignmentId}/open`, {
        method: "POST",
        credentials: "same-origin",
      });
      await fetch(`/api/reviews/${manifest.assignmentId}/progress`, {
        method: "POST",
        credentials: "same-origin",
      });
    })();
  }, [manifest.assignmentId]);

  async function onSubmitReview(output: HostedAnnotatorOutput) {
    setSubmissionState("submitting");
    setMessage("");

    const response = await fetch(`/api/reviews/${manifest.assignmentId}/submit`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(output),
    });

    if (!response.ok) {
      setSubmissionState("error");
      setMessage("Hosted review submission failed.");
      throw new Error("Hosted review submission failed.");
    }

    setSubmissionState("submitted");
    setMessage("Hosted review submitted.");
    router.push(`${caseDetailHref}?submitted=1`);
    router.refresh();
  }

  return (
    <div className="hosted-review-shell">
      {message ? (
        <div className={`review-workspace-toast ${submissionState === "error" ? "warning" : "success"}`}>
          {message}
        </div>
      ) : null}
      <div className="hosted-review-viewport">
        <App hostedReview={{ manifest, onSubmitReview }} />
      </div>
    </div>
  );
}

import React, { useEffect, useState } from "react";
import type { OpenPackageResult } from "../shared/ipc";
import SetupView from "./SetupView";
import OpenView from "./OpenView";
import ReviewView from "./ReviewView";

type AppState =
  | { kind: "setup" }
  | { kind: "open" }
  | { kind: "review"; pkg: OpenPackageResult };

export default function App(): React.ReactElement {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    (async () => {
      const name = await window.reviewerApi.getReviewerName();
      if (!name) {
        setState({ kind: "setup" });
        return;
      }
      // Check if app was launched by double-clicking a .endoseg file.
      const autoPath = await window.reviewerApi.getAutoOpen();
      if (autoPath) {
        const pkg = await window.reviewerApi.openPackage();
        if (pkg) { setState({ kind: "review", pkg }); return; }
      }
      setState({ kind: "open" });
    })();
  }, []);

  if (!state) return <div className="splash">Loading…</div>;

  if (state.kind === "setup") {
    return (
      <SetupView
        onDone={() => setState({ kind: "open" })}
      />
    );
  }

  if (state.kind === "open") {
    return (
      <OpenView
        onOpen={(pkg) => setState({ kind: "review", pkg })}
      />
    );
  }

  return (
    <ReviewView
      pkg={state.pkg}
      onClose={() => setState({ kind: "open" })}
    />
  );
}

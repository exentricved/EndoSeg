"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ReviewWorkspaceDrawerProps = {
  anchorId: string;
  closeHref: string;
  labelledBy: string;
  panelId: string;
  returnFocusId: string;
  children: React.ReactNode;
};

function getFocusableElements(root: HTMLElement | null) {
  if (!root) return [] as HTMLElement[];
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "textarea:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
  );
}

export function ReviewWorkspaceDrawer({
  anchorId,
  closeHref,
  labelledBy,
  panelId,
  returnFocusId,
  children,
}: ReviewWorkspaceDrawerProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [topOffset, setTopOffset] = useState(0);

  const restoreFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      document.getElementById(returnFocusId)?.focus();
    });
  }, [returnFocusId]);

  const closeDrawer = useCallback(() => {
    router.push(closeHref);
    restoreFocus();
  }, [closeHref, restoreFocus, router]);

  useEffect(() => {
    function updateTopOffset() {
      const anchor = document.getElementById(anchorId);
      setTopOffset(anchor ? Math.max(anchor.getBoundingClientRect().bottom, 0) : 0);
    }

    updateTopOffset();

    const anchor = document.getElementById(anchorId);
    const observer =
      anchor && "ResizeObserver" in window
        ? new ResizeObserver(() => {
            updateTopOffset();
          })
        : null;

    if (anchor && observer) {
      observer.observe(anchor);
    }

    window.addEventListener("resize", updateTopOffset);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateTopOffset);
    };
  }, [anchorId]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousTouchAction = document.body.style.touchAction;
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    closeButtonRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialogRef.current);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.style.touchAction = previousTouchAction;
    };
  }, [closeDrawer]);

  return (
    <>
      <button
        aria-hidden="true"
        className="review-workspace-backdrop"
        onClick={closeDrawer}
        tabIndex={-1}
        type="button"
      />
      <aside
        aria-labelledby={labelledBy}
        aria-modal="true"
        className="review-workspace-overlay"
        id={panelId}
        role="dialog"
        style={{ top: `${topOffset}px` }}
      >
        <div
          className="review-workspace-overlay-inner"
          onClick={(event) => event.stopPropagation()}
          ref={dialogRef}
          tabIndex={-1}
        >
          <div className="review-workspace-overlay-close">
            <button
              className="button ghost"
              onClick={closeDrawer}
              ref={closeButtonRef}
              type="button"
            >
              Close
            </button>
          </div>
          {children}
        </div>
      </aside>
    </>
  );
}

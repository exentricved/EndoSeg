"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type ReviewWorkspaceLaunchLinkProps = {
  href: string;
  className?: string;
  children: ReactNode;
  title?: string;
};

export function ReviewWorkspaceLaunchLink({
  href,
  className,
  children,
  title,
}: ReviewWorkspaceLaunchLinkProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocumentPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onDocumentPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onDocumentPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, []);

  function openInSeparateWindow() {
    const availWidth = Math.max(window.screen.availWidth || window.innerWidth || 1440, 1200);
    const availHeight = Math.max(window.screen.availHeight || window.innerHeight || 900, 800);
    const width = Math.min(availWidth - 32, 1720);
    const height = Math.min(availHeight - 48, 1080);
    const left = Math.max(Math.round((availWidth - width) / 2), 0);
    const top = Math.max(Math.round((availHeight - height) / 2), 0);
    const features = [
      "popup=yes",
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      "resizable=yes",
      "scrollbars=yes",
      "noopener=yes",
      "noreferrer=yes",
    ].join(",");

    const opened = window.open(href, "_blank", features);
    if (opened) {
      opened.focus();
    } else {
      window.open(href, "_blank", "noopener,noreferrer");
    }
    setOpen(false);
  }

  function openInCurrentTab() {
    setOpen(false);
    window.location.assign(href);
  }

  return (
    <div className="review-workspace-launch-menu" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className={`${className || "button primary"} review-workspace-launch-trigger`}
        onClick={() => setOpen((current) => !current)}
        title={title}
        type="button"
      >
        <span>{children}</span>
        <span aria-hidden="true" className="review-workspace-launch-caret">
          v
        </span>
      </button>

      {open ? (
        <div aria-label="Review workspace launch options" className="review-workspace-launch-popover" role="menu">
          <button className="review-workspace-launch-option" onClick={openInSeparateWindow} role="menuitem" type="button">
            Open in new window
          </button>
          <button className="review-workspace-launch-option" onClick={openInCurrentTab} role="menuitem" type="button">
            Open in this tab
          </button>
        </div>
      ) : null}
    </div>
  );
}

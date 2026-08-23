"use client";

import { useEffect, useState } from "react";
import { clsx } from "clsx";

export function SlideOver({
  open,
  onClose,
  shareUrl,
  children,
}: {
  open: boolean;
  onClose: () => void;
  shareUrl?: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  async function copyShareUrl() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return (
    <div
      className={clsx(
        "fixed inset-0 z-50 transition-opacity duration-300",
        open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
      )}
      aria-hidden={!open}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={clsx(
          "otto-material-thick otto-elevation-floating absolute inset-x-0 bottom-0 mx-auto h-[88vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border-t transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          open ? "translate-y-0" : "translate-y-full"
        )}
      >
        <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-otto-text-faint/40" />
        <div className="sticky top-4 z-10 mt-2 flex items-center justify-between px-4">
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-otto-border bg-otto-bg-raised text-otto-text-muted hover:text-otto-text"
            aria-label="Close"
          >
            ✕
          </button>
          {shareUrl && (
            <button
              onClick={copyShareUrl}
              className="rounded-full border border-otto-border bg-otto-bg-raised px-3 py-1.5 text-xs text-otto-text-muted hover:text-otto-text"
            >
              {copied ? "Copied!" : "Copy link"}
            </button>
          )}
        </div>
        <div className="px-4 pb-10 pt-2 sm:px-8">{children}</div>
      </div>
    </div>
  );
}

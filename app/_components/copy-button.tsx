"use client";

import { useState } from "react";

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label="Copy to clipboard"
      className={
        className ??
        "text-ink-muted hover:text-foreground shrink-0 rounded-md px-2 py-1 text-xs transition-colors"
      }
    >
      {copied ? "copied ✓" : "copy"}
    </button>
  );
}

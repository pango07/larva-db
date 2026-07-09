"use client";

import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={copy}
      className="bg-foreground text-background h-9 rounded-md px-5 text-sm font-medium transition-opacity hover:opacity-85"
    >
      {copied ? "Copied ✓" : "Copy prompt for your agent"}
    </button>
  );
}

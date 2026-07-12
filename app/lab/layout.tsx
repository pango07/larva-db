import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LarvaDB — the test lab",
  description:
    "A live SQL console over a real Larva database, plus concurrent-writer stress tests for the commit protocol: zero lost updates, or it fails loudly.",
};

export default function LabLayout({ children }: { children: React.ReactNode }) {
  return children;
}

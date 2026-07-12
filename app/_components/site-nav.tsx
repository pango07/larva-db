import Image from "next/image";
import Link from "next/link";

const LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/lab", label: "Test lab" },
  { href: "/viewer", label: "Data viewer" },
] as const;

export function SiteNav({ current }: { current?: "/lab" | "/viewer" }) {
  return (
    <nav className="border-hairline bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-6">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <Image
            src="/larva-mark.png"
            alt=""
            width={26}
            height={26}
            className="rounded-md"
            priority
          />
          larvadb
        </Link>
        <span className="grow" />
        <div className="hidden items-center gap-5 text-sm sm:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={
                l.href === current
                  ? "text-foreground font-medium"
                  : "text-ink-secondary hover:text-foreground transition-colors"
              }
            >
              {l.label}
            </Link>
          ))}
        </div>
        <a
          href="https://github.com/pango07/larva-db"
          className="text-ink-secondary hover:text-foreground transition-colors"
          aria-label="GitHub"
        >
          <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
        </a>
      </div>
    </nav>
  );
}

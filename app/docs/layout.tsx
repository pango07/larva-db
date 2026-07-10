import type { Metadata } from "next";
import Link from "next/link";
import { Layout, Navbar, Footer } from "nextra-theme-docs";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";

export const metadata: Metadata = {
  title: { template: "%s — LarvaDB docs", default: "LarvaDB docs" },
  description: "A tiny SQL database that lives inside your object store — the documentation.",
};

export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Layout
      navbar={
        <Navbar
          logo={<span style={{ fontWeight: 700 }}>🐛 larvadb</span>}
          projectLink="https://github.com/pango07/larva-db"
        >
          <Link href="/" style={{ fontSize: "0.875rem" }}>
            test lab
          </Link>
        </Navbar>
      }
      footer={
        <Footer>
          MIT — <a href="https://github.com/pango07/larva-db">pango07/larva-db</a> ·{" "}
          <a href="https://www.npmjs.com/package/@larva-db/core">@larva-db/core</a> · the agent
          prompt is served raw at <a href="/llms.txt">/llms.txt</a>
        </Footer>
      }
      pageMap={await getPageMap("/docs")}
      docsRepositoryBase="https://github.com/pango07/larva-db/tree/main"
      editLink="Edit this page on GitHub"
      sidebar={{ defaultMenuCollapseLevel: 1 }}
    >
      {children}
    </Layout>
  );
}

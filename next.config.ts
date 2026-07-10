import type { NextConfig } from "next";
import nextra from "nextra";

// Nextra renders the documentation (content/*.mdx) under /docs; the test lab
// (SQL console + stress lab) stays at /.
const withNextra = nextra({
  contentDirBasePath: "/docs",
});

const nextConfig: NextConfig = {};

export default withNextra(nextConfig);

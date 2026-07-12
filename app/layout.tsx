import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://larvadb.dev"),
  title: "LarvaDB — a real SQL database, living in your object store",
  description:
    "Larva turns Vercel Blob, S3, or R2 into a durable SQL database with transactions, time travel, and a Postgres escape hatch. No server, no connection string — just a bucket.",
  openGraph: {
    title: "LarvaDB — a real SQL database, living in your object store",
    description:
      "Real SQL, atomic transactions, time travel, and a Postgres escape hatch — inside the bucket you already have.",
    url: "https://larvadb.dev",
    siteName: "LarvaDB",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "larvadb" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}

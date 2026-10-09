import type { Metadata, Viewport } from "next";
import { Fraunces } from "next/font/google";
import { connection } from "next/server";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Grain } from "@/components/grain";
import { SmoothScroll } from "@/components/smooth-scroll";
import "./globals.css";

const display = Fraunces({
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "Kalypso: private payroll on Stellar",
  description:
    "Payroll on Stellar where nobody can read the salaries except the people who should.",
  icons: { icon: "/favicon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#15100f",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Every page renders per request so Next can stamp each response's CSP nonce (proxy.ts) on
  // its scripts. A page built ahead of time would carry none, and the policy would block it.
  await connection();
  return (
    <html
      lang="en"
      className={`${display.variable} ${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body>
        <SmoothScroll>{children}</SmoothScroll>
        <Grain />
      </body>
    </html>
  );
}

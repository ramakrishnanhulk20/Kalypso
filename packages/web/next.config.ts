import path from "node:path";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

// The site imports the deployment records from packages/contracts and links
// @kalypso/core from packages/core, so the bundler root is the repo root.
const repoRoot = path.join(import.meta.dirname, "../..");

// A second output folder lets a verification build run while the dev server
// is up, because both fight over the same .next folder otherwise.
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  // The dev badge would sit over the credits row during review.
  devIndicators: false,
  // Stops `next dev` from writing an AGENTS.md into the package.
  agentRules: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // No cross-origin isolation headers: core proves on one thread, which needs no
  // SharedArrayBuffer, and COOP same-origin would cut the anchor's cash-out popup off from
  // its opener (threat model C27). Revisit only together with a threads option in core.
};

// Compiles content/docs and writes the typed index into .source. Both paths are
// absolute because the repo's launch config starts the dev server from the repo
// root, and fumadocs-mdx would otherwise look for them there.
const withMDX = createMDX({
  configPath: path.join(import.meta.dirname, "source.config.ts"),
  outDir: path.join(import.meta.dirname, ".source"),
});

export default withMDX(nextConfig);

import path from "node:path";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

// The site imports the deployment records from packages/contracts and links
// @kalypso/core from packages/core, so the bundler root is the repo root.
const repoRoot = path.join(import.meta.dirname, "../..");

// next-intl finds its request config through this one alias. Its own plugin would set it, but
// the plugin checks the path from the directory the server was started in while Turbopack
// resolves it from this package, and the two differ between the launch config (repo root) and
// npm run dev (this package). Setting the alias here works from either.
const requestConfig = path.join(import.meta.dirname, "i18n/request.ts");

// A second output folder lets a verification build run while the dev server
// is up, because both fight over the same .next folder otherwise.
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  // The dev badge would sit over the credits row during review.
  devIndicators: false,
  // Stops `next dev` from writing an AGENTS.md into the package.
  agentRules: false,
  turbopack: { root: repoRoot, resolveAlias: { "next-intl/config": "./i18n/request.ts" } },
  outputFileTracingRoot: repoRoot,
  webpack: (config) => {
    config.resolve.alias["next-intl/config"] = requestConfig;
    return config;
  },
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

import { defineConfig } from "vitest/config";

// `vitest run --mode wire` (npm run test:wire) runs the same suite through the production driver
// over a socket, see test/db.ts. A flag and not an inline variable, because npm runs scripts in
// cmd.exe on Windows, where `NAME=value command` does not set anything.
export default defineConfig(({ mode }) => ({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: mode === "wire" ? { KALYPSO_TEST_DB: "wire" } : {},
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "text-summary"],
      thresholds: { lines: 90 },
    },
  },
}));

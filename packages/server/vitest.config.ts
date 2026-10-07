import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "text-summary"],
      thresholds: { lines: 90 },
    },
  },
});

import path from "node:path";
import { defineConfig } from "vitest/config";

// The same "@/" alias tsconfig.json gives the app, so a test can pull in a component that reaches
// its own modules that way, with no per-module mapping.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
});

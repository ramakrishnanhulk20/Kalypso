import { fileURLToPath } from "node:url";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins/remark-mdx-mermaid";

// This file is compiled into .source/, so the content folder is found from
// there. A relative path would follow the folder the dev server was started
// in, and the repo's launch config starts it from the repo root.
export const docs = defineDocs({
  dir: fileURLToPath(new URL("../content/docs", import.meta.url)),
});

export default defineConfig({
  mdxOptions: {
    // Turns ```mermaid blocks into <Mermaid chart="..." /> before the code
    // highlighter can colour them as plain text.
    remarkPlugins: (defaults) => [remarkMdxMermaid, ...defaults],
  },
});

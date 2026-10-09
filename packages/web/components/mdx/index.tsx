import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { Mermaid } from "./mermaid";

export function getMdxComponents(components?: MDXComponents): MDXComponents {
  return { ...defaultMdxComponents, Mermaid, ...components };
}

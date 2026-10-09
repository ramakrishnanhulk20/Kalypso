// Covers the page policy from threat model C28: the script-src line is exactly our own origin, the
// nonce, and WebAssembly compiling (plus 'unsafe-eval' in development only); 'strict-dynamic' is in
// no directive, so a script our own code inserts cannot load from another host; the request Next
// reads the nonce from carries the same policy as the response; every call gets a new nonce; and
// no site can frame the page.
// Does NOT cover: what a browser does with the policy (scratchpad/csp/inject.mjs drives a real one),
// the connect-src host list, or which paths the matcher lets through.
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import proxy from "./proxy";

function run(mode: "production" | "development") {
  vi.stubEnv("NODE_ENV", mode);
  const response = proxy(new NextRequest("http://localhost:3000/worker"));
  const policy = response.headers.get("Content-Security-Policy") ?? "";
  const directives = policy.split("; ");
  const scriptSrc = directives.find((directive) => directive.startsWith("script-src ")) ?? "";
  const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1] ?? "";
  return { response, policy, directives, scriptSrc, nonce };
}

afterEach(() => vi.unstubAllEnvs());

describe("the page policy", () => {
  it("allows scripts from our own origin, the nonce and WebAssembly in production, and nothing else", () => {
    const { scriptSrc, nonce } = run("production");
    expect(nonce).not.toBe("");
    expect(scriptSrc).toBe(`script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`);
  });

  it("adds only 'unsafe-eval' in development", () => {
    const { scriptSrc, nonce } = run("development");
    expect(scriptSrc).toBe(`script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-eval'`);
  });

  it("puts 'strict-dynamic' in no directive, in either mode", () => {
    for (const mode of ["production", "development"] as const) {
      const { policy, directives } = run(mode);
      expect(policy).not.toContain("strict-dynamic");
      for (const directive of directives) expect(directive).not.toContain("strict-dynamic");
    }
  });

  it("gives the request Next reads the nonce from the same policy as the response", () => {
    for (const mode of ["production", "development"] as const) {
      const { response, policy } = run(mode);
      expect(policy).not.toBe("");
      expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
      expect(response.headers.get("x-middleware-override-headers")).toContain("content-security-policy");
    }
  });

  it("makes a new nonce for every call", () => {
    const first = run("production").nonce;
    const second = run("production").nonce;
    expect(first).not.toBe("");
    expect(second).not.toBe("");
    expect(first).not.toBe(second);
  });

  it("lets no site frame the page", () => {
    const { response, directives } = run("production");
    expect(directives).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

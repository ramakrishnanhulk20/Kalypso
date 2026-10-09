import { NextResponse, type NextRequest } from "next/server";

// Threat model C28: a script runs only when it comes from our own origin or carries this
// response's nonce, never from another host even when our own code inserts it, nothing outside
// the hosts below can be reached from the page, and no site can frame it.
function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets the prover and the witness solver compile WebAssembly; it does
    // not allow eval of JavaScript. 'unsafe-eval' is development only: Next's CSP guide says
    // React needs it there to rebuild server error stacks, and production never uses eval.
    // No 'strict-dynamic': with it a browser ignores 'self' and lets any script the page's own code
    // inserts load from any host. Next stamps the nonce on its inline scripts and every chunk is
    // same-origin, so 'self' plus the nonce is all the app needs.
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    // React style attributes and the motion library write inline styles. Scripts never get this.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "worker-src 'self' blob:",
    // bb.js loads its WebAssembly by fetching a data: URL it carries inside itself. A data: fetch
    // never leaves the browser. Its proving data comes from /crs on this origin (lib/prover-data.ts).
    "connect-src 'self' data: https://soroban-testnet.stellar.org https://horizon-testnet.stellar.org https://friendbot.stellar.org https://testanchor.stellar.org",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Sets a fresh nonce and the page's security headers on every matched request. The policy goes
 * on the request too, because that is where Next reads the nonce it stamps on its own scripts,
 * which is why every page renders per request (app/layout.tsx).
 */
export default function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

// Skips only build output, image optimisation, the favicon and the proving data, none of which
// is a document. Anything else, including a file added to public/ later, still gets the headers,
// which costs nothing. Prefetches are not skipped: a prefetched document served without the
// policy could be the one the browser then navigates to.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon|crs/).*)"],
};

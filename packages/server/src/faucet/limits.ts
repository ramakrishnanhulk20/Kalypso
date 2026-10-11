// This file imports nothing, so the browser can import it too (packages/web/lib/faucet.ts) without
// pulling the server's database driver into the page.

/**
 * The longest one faucet claim runs on the server. Every RPC call a claim makes (the destination
 * read, the faucet read, the send, every confirmation poll and the last one) shares one deadline
 * this long after the claim starts, so the parts always fit inside it. 45 s leaves the route's
 * 60 s maxDuration room for the claim's database statements, each cut off at 5 s. The page waits
 * FAUCET_MAX_MS + 15 s, so it never gives up on a claim the server is still confirming.
 */
export const FAUCET_MAX_MS = 45_000;

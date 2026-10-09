import { ConfigError, loadConfig, type Config } from "@kalypso/server";

/** A checked server config, or the names of the variables that stopped it. */
export type ServerConfig =
  | { readonly ok: true; readonly cfg: Config; readonly memoryDb: boolean }
  | { readonly ok: false; readonly missing: readonly string[]; readonly invalid: readonly string[] };

let memo: ServerConfig | undefined;

/**
 * The server variables, read from process.env on the first request of a cold
 * start and kept for its life. A deployment's environment is fixed when it
 * starts, so a failed check is kept too: it cannot pass until a redeploy.
 */
export function serverConfig(): ServerConfig {
  if (memo === undefined) {
    // The literal process.env.NODE_ENV lets a production build fold this to
    // false, whatever else is set.
    const memoryDb = process.env.NODE_ENV === "development" && devMemoryDbRequested(process.env);
    memo = checkServerEnv(memoryDb ? { ...process.env, ...DEV_MEMORY_DB_URLS } : process.env, memoryDb);
  }
  return memo;
}

/**
 * The in-memory database switch: on only in development, with
 * KALYPSO_DEV_MEMORY_DB=1 and neither database URL set. A URL means a real
 * database was meant, so the switch stays off rather than shadow it.
 */
export function devMemoryDbRequested(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === "development" && env.KALYPSO_DEV_MEMORY_DB === "1" && !env.DATABASE_URL_INGEST && !env.DATABASE_URL_API;
}

// Stand-ins that let the server's own check pass. Nothing connects to them:
// with the switch on, both sides get the in-memory database instead.
const DEV_MEMORY_DB_URLS = {
  DATABASE_URL_INGEST: "postgres://dev-memory@localhost/kalypso",
  DATABASE_URL_API: "postgres://dev-memory@localhost/kalypso",
};

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Runs the server package's own check and never throws. A failure carries
 * variable names only, never a value or a rule's text, because several of
 * the values are secrets and the names are what goes into a log line.
 */
export function checkServerEnv(env: Record<string, string | undefined>, memoryDb = false): ServerConfig {
  try {
    return { ok: true, cfg: loadConfig(env), memoryDb };
  } catch (err) {
    const missing = new Set<string>();
    const invalid = new Set<string>();
    const problems = err instanceof ConfigError ? err.problems : ["config: unreadable"];
    // Each problem reads "NAME: missing" or "NAME: <rule>" (loadConfig). A
    // name not in variable shape is reported as "config" so nothing else can
    // ride along into the log.
    for (const problem of problems) {
      const cut = problem.indexOf(": ");
      const name = cut > 0 && VARIABLE_NAME.test(problem.slice(0, cut)) ? problem.slice(0, cut) : "config";
      (problem.slice(cut + 2) === "missing" ? missing : invalid).add(name);
    }
    return { ok: false, missing: [...missing], invalid: [...invalid] };
  }
}

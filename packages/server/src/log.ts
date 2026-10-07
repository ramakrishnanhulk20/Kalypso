export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export type LogSink = (line: string) => void;

/**
 * One JSON line per event. Callers pass explicit fields, and the finished
 * line is still scrubbed for every secret value in every spelling it could
 * take inside JSON (raw, URL-encoded, JSON-escaped), because a field can carry
 * a secret its caller did not know about, for example an upstream error.
 */
export function createLogger(secrets: readonly string[], sink: LogSink = (line) => console.log(line)): Logger {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(JSON.stringify(secret).slice(1, -1));
  }
  const ordered = [...forms].sort((a, b) => b.length - a.length);

  const write = (level: "info" | "warn", event: string, fields: Record<string, unknown> = {}) => {
    let line: string;
    try {
      line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
    } catch {
      line = JSON.stringify({ t: new Date().toISOString(), level, event, note: "fields not serialisable" });
    }
    for (const form of ordered) line = line.split(form).join("[redacted]");
    sink(line);
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
  };
}

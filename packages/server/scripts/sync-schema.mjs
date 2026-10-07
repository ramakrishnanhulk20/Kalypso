// Copies src/archive/schema.sql into src/archive/schema.ts, so a bundler can
// ship the schema without tracing a .sql file. Edit schema.sql, then run:
//
//   node scripts/sync-schema.mjs
//
// test/archive/schema.test.ts fails whenever the two copies differ.
import { readFileSync, writeFileSync } from "node:fs";

const sqlPath = new URL("../src/archive/schema.sql", import.meta.url);
const tsPath = new URL("../src/archive/schema.ts", import.meta.url);
const sql = readFileSync(sqlPath, "utf8");

// The SQL goes into a template literal, so these three would change its meaning.
for (const forbidden of ["`", "${", "\\"]) {
  if (sql.includes(forbidden)) {
    console.error("schema.sql contains " + JSON.stringify(forbidden) + "; it cannot be embedded as written");
    process.exit(1);
  }
}

writeFileSync(
  tsPath,
  "// Generated from schema.sql by scripts/sync-schema.mjs. Edit schema.sql, not this file.\n" +
    "export const SCHEMA_SQL = `" + sql + "`;\n",
);
console.log("wrote src/archive/schema.ts (" + sql.length + " characters)");

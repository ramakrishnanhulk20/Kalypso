// Not covered here: whether the schema suits a given hosting provider; the
// archive and sponsor tests run every statement in it against PGlite.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { schemaSql } from "../../src/archive/db.ts";
import { SCHEMA_SQL } from "../../src/archive/schema.ts";

describe("embedded schema", () => {
  it("is byte for byte the readable schema.sql (run node scripts/sync-schema.mjs after editing it)", () => {
    expect(SCHEMA_SQL).toBe(readFileSync(new URL("../../src/archive/schema.sql", import.meta.url), "utf8"));
  });

  it("is what applySchema runs, with no file read at run time", () => {
    expect(schemaSql()).toBe(SCHEMA_SQL);
    expect(readFileSync(new URL("../../src/archive/db.ts", import.meta.url), "utf8")).not.toMatch(/node:fs|readFile/);
  });
});

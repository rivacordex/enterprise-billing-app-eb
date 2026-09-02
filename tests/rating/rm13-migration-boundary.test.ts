import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkFileForBillingWrites,
  checkRatingMigrationBoundary,
  findRatingMigrationFiles,
} from "@/db/checks/rating-migration-boundary";

// rm13-spec D4/Implementation §4 + verification checklist item 5: "The
// migration-boundary check fails a migration that writes billing.* and
// passes the real rating migrations." No DATABASE_URL needed — this is a
// pure filesystem/text scan, run in the default (DB-free) vitest project.
describe("rm13 migration-boundary check (rm13-spec D4)", () => {
  it("passes the real rating migration(s) in db/migrations", () => {
    const dir = join(process.cwd(), "db", "migrations");
    const files = findRatingMigrationFiles(dir);
    // At least the rm01 foundation migration must be found — an empty match
    // list would make this test vacuously pass.
    expect(files.length).toBeGreaterThan(0);
    expect(checkRatingMigrationBoundary(dir)).toEqual([]);
  });

  it("flags a rating migration that writes billing.* as a real statement", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm13-migration-boundary-"));
    const path = join(dir, "0099_rating_bad.sql");
    writeFileSync(
      path,
      [
        "CREATE TABLE rating.udr_extra (id uuid PRIMARY KEY);",
        "--> statement-breakpoint",
        "INSERT INTO billing.billing_account (name) VALUES ('leaked');",
      ].join("\n"),
      "utf8",
    );
    const violations = checkFileForBillingWrites(path);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.text).toBe("billing.billing_account");
    expect(checkRatingMigrationBoundary(dir)).toHaveLength(1);
  });

  it("does not flag billing mentioned only in a SQL comment describing the invariant", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm13-migration-boundary-"));
    const path = join(dir, "0099_rating_ok.sql");
    writeFileSync(
      path,
      [
        "-- Inv #17: no FK into or out of billing.* — cross-schema references",
        "-- are plain text (e.g. a resolved billing.billing_account id).",
        "/* also fine inside a block comment: billing.bill_cycle */",
        "CREATE TABLE rating.udr_rated (id uuid PRIMARY KEY);",
      ].join("\n"),
      "utf8",
    );
    expect(checkFileForBillingWrites(path)).toEqual([]);
  });

  it("ignores a non-rating migration file even if it writes billing.*", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm13-migration-boundary-"));
    writeFileSync(
      join(dir, "0005_billing.sql"),
      "INSERT INTO billing.billing_account (name) VALUES ('fine, owns its own schema');",
      "utf8",
    );
    expect(checkRatingMigrationBoundary(dir)).toEqual([]);
  });

  it("reports the correct 1-indexed line number for a violation", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm13-migration-boundary-"));
    const path = join(dir, "0099_rating_lineno.sql");
    writeFileSync(
      path,
      [
        "CREATE TABLE rating.foo (id uuid);",
        "-- a comment line",
        "SELECT * FROM billing.bill_cycle;",
      ].join("\n"),
      "utf8",
    );
    const violations = checkFileForBillingWrites(path);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(3);
  });
});

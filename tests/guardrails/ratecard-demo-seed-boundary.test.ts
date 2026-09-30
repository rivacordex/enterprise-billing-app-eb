import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// pm67 — the demo rate-card seed's DB-free boundary gate. Static source
// assertions only (node:fs, no jsdom, no DB), the same shape as
// demo-seed-boundary.test.ts. It proves the FOUR things the pm67 spec can check
// without a database:
//   - I3.9 / D7: the two seeds the unit swears it never touches
//     (db/seeds/product.ts — the ADMIN grant seed — and
//     db/seeds/sample/seed-billrun-sample.ts) carry NO rate-card artifact, so
//     the card seed did not leak into them. (Byte-identical is confirmed by
//     `git diff` in the change description; this guard catches a future leak.)
//   - I2 / §2.24: the seed builds its CSV headers from pm58's imported header
//     map, never re-spelling the ten header strings.
//   - I3.1 wiring: db:seed-demo actually runs the card seed (product-demo
//     exports it and seed-demo.ts calls it), and it does so on the app pool.
//   - D4: the seed is small and human-readable — not 5,400 rows.
const REPO_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const PRODUCT_DEMO = "db/seeds/demo/product-demo.ts";
const SEED_DEMO = "db/seeds/demo/seed-demo.ts";
const ADMIN_GRANT_SEED = "db/seeds/product.ts";
const SAMPLE_SEED = "db/seeds/sample/seed-billrun-sample.ts";

// A leak of the rate-card seed into a file it must not touch: any mention of
// the card module, its table, or the upload/activate services. Deliberately
// NOT the bare token `RAN_USAGE` — that is also the UDR type name the sample
// seed legitimately uses (`_SAMPLE_`-marked udr_rated rows), so matching it
// would be a false positive; the rate-card artifacts are the `ratecard*`
// spellings and the service file names.
const RATE_CARD_ARTIFACT =
  /ratecard|RATECARD_RAN_USAGE_LKP|ran_usage_lkp|seedRateCardDemo|upload-version|activate-version|rollback-version/i;

describe("pm67 demo rate-card seed — boundaries (D7, I2, I3.9)", () => {
  it("db/seeds/product.ts (the ADMIN grant seed) carries no rate-card artifact (D7 — confirmed untouched)", () => {
    expect(read(ADMIN_GRANT_SEED)).not.toMatch(RATE_CARD_ARTIFACT);
  });

  it("db/seeds/sample/seed-billrun-sample.ts carries no rate-card artifact (D7 — confirmed untouched)", () => {
    expect(read(SAMPLE_SEED)).not.toMatch(RATE_CARD_ARTIFACT);
  });

  it("the card seed builds its CSV header from pm58's imported header map, not re-spelled strings (I2, §2.24)", () => {
    const src = read(PRODUCT_DEMO);
    // Imports the single source of truth for the ten headers ...
    expect(src).toMatch(
      /import\s*\{[^}]*RATE_CARD_FILE_HEADERS[^}]*RATE_CARD_HEADER_MAP[^}]*\}\s*from\s*"@\/validation\/product\/ratecard\.schema"/s,
    );
    // ... and never types a raw file-header string (e.g. "MNO Name",
    // "Subscriber Reference ID") — the map is the only place those live.
    expect(src).not.toContain('"MNO Name"');
    expect(src).not.toContain('"Subscriber Reference ID"');
    expect(src).not.toContain('"Rate per Unit"');
  });

  it("db:seed-demo runs the card seed on the app pool, after the product/ordering transaction (I3.1 wiring)", () => {
    const productDemo = read(PRODUCT_DEMO);
    // product-demo exports the seed and the single tracked card name (D-A5).
    expect(productDemo).toMatch(/export\s+async\s+function\s+seedRateCardDemo/);
    expect(productDemo).toMatch(/RAN_USAGE_CARD_NAME\s*=\s*"RAN_USAGE"/);
    // It calls the REAL services (D2), not a hand-set status write.
    expect(productDemo).toContain("uploadRatecardVersion");
    expect(productDemo).toContain("activateRatecardVersion");
    expect(productDemo).not.toMatch(/status:\s*"ACTIVE"/);

    const seedDemo = read(SEED_DEMO);
    expect(seedDemo).toContain("seedRateCardDemo");
    // Wired AFTER the product/ordering transaction body (the services open
    // their own transactions on the app pool; the FK'd appuser must be
    // committed first), and the app pool is closed so the script exits.
    const inTx = seedDemo.indexOf("await seedOrderingDemo(tx)");
    const call = seedDemo.indexOf("await seedRateCardDemo()");
    expect(inTx).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(inTx);
    expect(seedDemo).toMatch(/appDb\.\$client\.end/);
  });

  it("the seed is small and human-readable — not 5,400 rows (D4)", () => {
    const src = read(PRODUCT_DEMO);
    // Count demoRow(...) fixture calls; a handful, never thousands.
    const rows = (src.match(/demoRow\(/g) ?? []).length;
    expect(rows).toBeGreaterThan(2);
    expect(rows).toBeLessThanOrEqual(20);
    // No row-generating loop in the card seed — the fixtures are literal rows,
    // never a `for`/`Array.from` batch (which is how a 5,400-row card would be
    // built). `seedRateCardDemo` maps over its own literal arrays only.
    expect(src).not.toMatch(/Array\.from\([^)]*length/);
  });
});

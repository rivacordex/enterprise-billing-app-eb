import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  expectNotOnboarded,
  type OnboardingDatabase,
  seedInitializedCustomer,
  setUpOnboardingDatabase,
  tearDownOnboardingDatabase,
} from "@/tests/helpers/onboarding-database";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";

// ac04-spec §3.4 — V7 onboarding-atomicity test (code-standards §7.1).
// Asserts Module Inv. #5: if the transaction fails at any point after the
// party_role status change and FA/BAN inserts, every write rolls back
// atomically — the party_role reverts to INITIALIZED, no financial_account or
// billing_account row persists, and the pgledger balance remains 0.
//
// The failure is injected by spying on ledgerRepository.createAccount to throw
// after the FA/BAN inserts have been written (step 2c), exercising the
// production db.transaction path owned by onboardCustomerAccounts.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "Onboarding atomicity — V7 (Module Inv. #5, requires DATABASE_URL)",
  () => {
    let db: OnboardingDatabase;

    beforeAll(async () => {
      db = await setUpOnboardingDatabase(databaseUrl as string, "v07");
    }, 60_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await tearDownOnboardingDatabase(db.sql);
    });

    it("V7 — failure at ledger creation rolls back party_role status, FA, and BAN", async () => {
      const pr = await seedInitializedCustomer(db, "V07 Test Org");

      // Inject failure at step 2c: ledgerRepository.createAccount throws on its
      // first call (after FA/BAN inserts have been written inside the service's
      // own db.transaction), triggering a rollback of all prior writes.
      vi.spyOn(ledgerRepository, "createAccount").mockRejectedValueOnce(
        new Error("V07 injected ledger failure"),
      );

      await expect(
        onboardCustomerAccounts(
          {
            partyRoleId: pr.id,
            billCycleId: db.cycleId,
            currency: "MYR",
            statusReason: "V07 atomicity test",
            lastModifiedDatetime: pr.ts,
          },
          db.appuserId,
        ),
      ).rejects.toThrow("V07 injected ledger failure");

      // V7 headline: the transaction rolled back all prior writes — party_role
      // is still INITIALIZED, no financial_account / billing_account row.
      await expectNotOnboarded(db.sql, pr.id);

      // No ledger_binding rows.
      const [bindingCheck] = await db.sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.ledger_binding
      `;
      expect(Number(bindingCheck?.count)).toBe(0);
    });

    it("V7 — V1 zero-sum holds after a rolled-back onboarding attempt", async () => {
      // pgledger_create_account was never called in the failed attempt above
      // (the spy threw before any ledger account was committed), so the balance
      // check is trivially satisfied. This assertion makes the invariant explicit.
      const [sum] = await db.sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total
        FROM billing.pgledger_accounts_view
      `;
      expect(Number(sum?.total ?? "0")).toBe(0);
    });
  },
);

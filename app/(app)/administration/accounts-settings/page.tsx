import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import {
  AddReasonCodeButton,
  ReasonCodeActions,
} from "@/components/accounts/reason-code-form";
import {
  AddBillCycleButton,
  BillCycleActions,
} from "@/components/accounts/bill-cycle-form";
import { WizardDefaultsForm } from "@/components/accounts/wizard-defaults-form";
import { listReasonCodes } from "@/services/accounts/reason-code";
import { listBillCycles } from "@/services/accounts/bill-cycle";
import { getWizardDefaultsFull } from "@/services/accounts/wizard-defaults";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Accounts Settings" };

function StateChip({ state }: { state: string }): React.JSX.Element {
  const cls =
    state === "active"
      ? "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]"
      : "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-400)]";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase ${cls}`}
    >
      {state === "active" ? "Active" : "Retired"}
    </span>
  );
}

export default async function AccountsSettingsPage(): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.ACCOUNTS_CONFIG, LEVELS.EDIT);

  const [reasonCodes, billCycles, wizardDefaults] = await Promise.all([
    listReasonCodes(),
    listBillCycles(),
    getWizardDefaultsFull(),
  ]);

  const activeCycles = billCycles.filter((c) => c.state === "active");

  return (
    <main className="space-y-10 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">
          Accounts Settings
        </h1>
        <p className="mt-1 text-body text-muted-foreground">
          Manage reason codes, bill-cycle catalog, and onboarding wizard
          defaults.
        </p>
      </header>

      {/* ── §2.1 Reason Codes + Thresholds ─────────────────────────────────── */}
      <section className="space-y-3" aria-labelledby="rc-heading">
        <div className="flex items-center justify-between">
          <div>
            <h2
              id="rc-heading"
              className="text-h3 font-semibold text-foreground"
            >
              Reason Codes &amp; Thresholds
            </h2>
            <p className="text-body-sm text-muted-foreground">
              Each code maps a doc type to a posting nature and sets the
              auto-post limit (Q20). Threshold changes are audited and affect
              ac07 routing immediately.
            </p>
          </div>
          <AddReasonCodeButton />
        </div>

        <div className="overflow-x-auto rounded-md border border-[color:var(--border-default)]">
          <table className="min-w-full text-body-sm">
            <thead>
              <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)]">
                {[
                  "Code",
                  "Name",
                  "Doc Type",
                  "Posting Nature",
                  "Limit (MYR)",
                  "State",
                  "",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border-subtle)]">
              {reasonCodes.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-body text-muted-foreground"
                  >
                    No reason codes — add one above.
                  </td>
                </tr>
              ) : (
                reasonCodes.map((rc) => (
                  <tr
                    key={rc.reasonCode}
                    className="bg-[color:var(--surface-card)] hover:bg-[color:var(--surface-sunken)]"
                  >
                    <td className="px-4 py-2 font-mono font-medium text-foreground">
                      {rc.reasonCode}
                    </td>
                    <td className="px-4 py-2 text-foreground">
                      {rc.name ?? (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-muted-foreground">
                      {rc.docType}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {rc.postingNature}
                    </td>
                    <td className="px-4 py-2 text-foreground tabular-nums">
                      {rc.autoPostLimit === "0" ||
                      rc.autoPostLimit === "0.00" ? (
                        <span className="text-muted-foreground">
                          0 (always four-eyes)
                        </span>
                      ) : (
                        rc.autoPostLimit
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <StateChip state={rc.state} />
                    </td>
                    <ReasonCodeActions row={rc} />
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── §2.2 Bill-Cycle Catalog ─────────────────────────────────────────── */}
      <section className="space-y-3" aria-labelledby="bc-heading">
        <div className="flex items-center justify-between">
          <div>
            <h2
              id="bc-heading"
              className="text-h3 font-semibold text-foreground"
            >
              Bill-Cycle Catalog
            </h2>
            <p className="text-body-sm text-muted-foreground">
              Retiring a cycle removes it from new-account onboarding while
              leaving existing BANs intact (V9 / Inv. #11).
            </p>
          </div>
          <AddBillCycleButton />
        </div>

        <div className="overflow-x-auto rounded-md border border-[color:var(--border-default)]">
          <table className="min-w-full text-body-sm">
            <thead>
              <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)]">
                {[
                  "Name",
                  "Frequency",
                  "Cycle Day",
                  "Due Days",
                  "State",
                  "",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border-subtle)]">
              {billCycles.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-body text-muted-foreground"
                  >
                    No bill cycles — add one above.
                  </td>
                </tr>
              ) : (
                billCycles.map((bc) => (
                  <tr
                    key={bc.billCycleId}
                    className="bg-[color:var(--surface-card)] hover:bg-[color:var(--surface-sunken)]"
                  >
                    <td className="px-4 py-2 font-medium text-foreground">
                      {bc.name}
                      {bc.billCycleId === wizardDefaults.defaultBillCycleId && (
                        <span className="ml-2 inline-flex items-center rounded-full bg-[color:var(--color-primary-50)] px-2 py-0.5 text-[10px] font-semibold tracking-wider text-[color:var(--color-primary-700)] uppercase">
                          Default
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground capitalize">
                      {bc.frequency}
                    </td>
                    <td className="px-4 py-2 text-foreground tabular-nums">
                      Day {bc.cycleDay}
                    </td>
                    <td className="px-4 py-2 text-foreground tabular-nums">
                      {bc.paymentDueDays} days
                    </td>
                    <td className="px-4 py-2">
                      <StateChip state={bc.state} />
                    </td>
                    <BillCycleActions
                      row={bc}
                      defaultBillCycleId={wizardDefaults.defaultBillCycleId}
                      currentCreditLimit={wizardDefaults.defaultCreditLimit}
                    />
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── §2.3 Wizard Defaults ────────────────────────────────────────────── */}
      <section className="space-y-3" aria-labelledby="wd-heading">
        <div>
          <h2 id="wd-heading" className="text-h3 font-semibold text-foreground">
            Onboarding Wizard Defaults
          </h2>
          <p className="text-body-sm text-muted-foreground">
            These values pre-fill the account-creation wizard (ac04). They are
            read live; changes take effect on the next wizard session.
          </p>
        </div>
        <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4">
          <WizardDefaultsForm
            activeCycles={activeCycles}
            defaultBillCycleId={wizardDefaults.defaultBillCycleId}
            defaultCurrency={wizardDefaults.defaultCurrency}
            defaultCreditLimit={wizardDefaults.defaultCreditLimit}
          />
        </div>
      </section>

      {/* ── §2.4 Flows documentation link ───────────────────────────────────── */}
      <section className="space-y-2" aria-labelledby="flows-heading">
        <h2
          id="flows-heading"
          className="text-h3 font-semibold text-foreground"
        >
          Transaction Flows Reference
        </h2>
        <p className="text-body-sm text-muted-foreground">
          Config-driven documentation of PAY / DEP / CRN / DBN / ADJ flows,
          reason-code → nature → GL mapping, and approval thresholds.
        </p>
        <Link
          href="/administration/accounts-settings/flows"
          className="inline-flex h-8 items-center rounded-md border border-[color:var(--border-default)] px-3 text-body-sm text-foreground hover:bg-[color:var(--surface-sunken)]"
        >
          View Flows Documentation →
        </Link>
      </section>
    </main>
  );
}

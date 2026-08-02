import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { listReasonCodes } from "@/services/accounts/reason-code";
import { listBillCycles } from "@/services/accounts/bill-cycle";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Transaction Flows Reference" };

const DOC_FLOW_ROWS = [
  {
    docType: "PAY",
    label: "Payment",
    flow: "Capture → allocation against open invoices",
    reversal: "PAY_REV — reverses allocation, restores invoice balance",
    notes:
      "Payment allocation is idempotent; partial allocation leaves remainder as unapplied cash.",
  },
  {
    docType: "DEP",
    label: "Deposit",
    flow: "Capture → held as deposit liability on BAN",
    reversal: "DEP_REV — releases liability; may trigger refund posting",
    notes:
      "Deposit release requires explicit instruction; not auto-released on account closure.",
  },
  {
    docType: "CRN",
    label: "Credit Note",
    flow: "Credit note raised → reduces BAN AR balance",
    reversal: "No reversal — issue a matching DBN to offset",
    notes:
      "CRN reduces the customer's outstanding balance. Use for billing corrections.",
  },
  {
    docType: "DBN",
    label: "Debit Note",
    flow: "Debit note raised → increases BAN AR balance",
    reversal: "No reversal — issue a matching CRN to offset",
    notes:
      "DBN increases the customer's outstanding balance. Use for undercharges.",
  },
  {
    docType: "ADJ",
    label: "Adjustment",
    flow: "Directional adjustment posted to BAN ledger",
    reversal: "ADJ_REV — full reversal of the original adjustment entry",
    notes:
      "Adjustments carry a reason code that maps to posting nature and determines GL routing.",
  },
] as const;

const NATURE_ROWS = [
  {
    nature: "revenue",
    description: "Income posting — increases revenue GL",
    normalBalance: "Cr",
    sysAccount: "sys.revenue",
  },
  {
    nature: "revenue_adj",
    description: "Credit adjustment — reduces AR without cash movement",
    normalBalance: "Cr",
    sysAccount: "sys.revenue_adj",
  },
  {
    nature: "write_off",
    description: "Bad-debt write-off — removes uncollectable AR",
    normalBalance: "Dr",
    sysAccount: "sys.write_off",
  },
  {
    nature: "rounding",
    description: "Cent-rounding correction — absorbs sub-cent remainders",
    normalBalance: "Dr / Cr",
    sysAccount: "sys.rounding",
  },
  {
    nature: "cash",
    description: "Cash movement — bank / cash GL side of a payment",
    normalBalance: "Dr",
    sysAccount: "sys.cash",
  },
  {
    nature: "deposit_movement",
    description: "Deposit capture or release against the deposit liability GL",
    normalBalance: "Cr (capture) / Dr (release)",
    sysAccount: "sys.deposit",
  },
] as const;

export default async function AccountsSettingsFlowsPage(): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.ACCOUNTS_CONFIG, LEVELS.READ);

  const [reasonCodes, billCycles] = await Promise.all([
    listReasonCodes(),
    listBillCycles(),
  ]);

  const activeReasonCodes = reasonCodes.filter((rc) => rc.state === "active");
  const activeBillCycles = billCycles.filter((bc) => bc.state === "active");

  return (
    <main className="space-y-10 p-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-h1 font-semibold text-foreground">
            Transaction Flows Reference
          </h1>
          <p className="mt-1 text-body text-muted-foreground">
            Config-driven documentation rendered from the live reason-code and
            bill-cycle catalogs. Updates automatically when catalogs change.
          </p>
        </div>
        <Link
          href="/administration/accounts-settings"
          className="inline-flex h-8 items-center rounded-md border border-[color:var(--border-default)] px-3 text-body-sm text-foreground hover:bg-[color:var(--surface-sunken)]"
        >
          ← Back to Settings
        </Link>
      </header>

      {/* ── Doc-type flows ─────────────────────────────────────────────────── */}
      <section className="space-y-3" aria-labelledby="flows-heading">
        <h2
          id="flows-heading"
          className="text-h3 font-semibold text-foreground"
        >
          Document Flows (PAY / DEP / CRN / DBN / ADJ)
        </h2>
        <p className="text-body-sm text-muted-foreground">
          Each document type follows a fixed capture → ledger-posting → optional
          reversal lifecycle. Reversal documents inherit the original&apos;s
          reason code and invert the posting.
        </p>
        <div className="overflow-x-auto rounded-md border border-[color:var(--border-default)]">
          <table className="min-w-full text-body-sm">
            <thead>
              <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)]">
                {["Type", "Label", "Flow", "Reversal", "Notes"].map((h) => (
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
              {DOC_FLOW_ROWS.map((row) => (
                <tr
                  key={row.docType}
                  className="bg-[color:var(--surface-card)]"
                >
                  <td className="px-4 py-3 font-mono font-semibold text-foreground">
                    {row.docType}
                  </td>
                  <td className="px-4 py-3 font-medium text-foreground">
                    {row.label}
                  </td>
                  <td className="px-4 py-3 text-foreground">{row.flow}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {row.reversal}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {row.notes}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Posting nature → GL mapping ───────────────────────────────────── */}
      <section className="space-y-3" aria-labelledby="nature-heading">
        <h2
          id="nature-heading"
          className="text-h3 font-semibold text-foreground"
        >
          Posting Nature → System Account Mapping
        </h2>
        <p className="text-body-sm text-muted-foreground">
          The reason code&apos;s{" "}
          <code className="font-mono">posting_nature</code> determines which
          system ledger account receives the contra side of every posting.
        </p>
        <div className="overflow-x-auto rounded-md border border-[color:var(--border-default)]">
          <table className="min-w-full text-body-sm">
            <thead>
              <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)]">
                {[
                  "Nature",
                  "Description",
                  "Normal Balance",
                  "System Account",
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
              {NATURE_ROWS.map((row) => (
                <tr key={row.nature} className="bg-[color:var(--surface-card)]">
                  <td className="px-4 py-3 font-mono text-foreground">
                    {row.nature}
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {row.description}
                  </td>
                  <td className="px-4 py-3 font-mono text-muted-foreground">
                    {row.normalBalance}
                  </td>
                  <td className="px-4 py-3 font-mono text-muted-foreground">
                    {row.sysAccount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Live reason codes with thresholds ────────────────────────────── */}
      <section className="space-y-3" aria-labelledby="rc-heading">
        <h2 id="rc-heading" className="text-h3 font-semibold text-foreground">
          Active Reason Codes &amp; Approval Thresholds
        </h2>
        <p className="text-body-sm text-muted-foreground">
          Amounts at or below the limit auto-post; amounts above require
          four-eyes approval (ac07). A limit of 0 means all postings of this
          code require approval.
        </p>
        {activeReasonCodes.length === 0 ? (
          <p className="text-body text-muted-foreground">
            No active reason codes.{" "}
            <Link
              href="/administration/accounts-settings"
              className="text-[color:var(--action-primary-bg)] hover:underline"
            >
              Add one in Settings.
            </Link>
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-[color:var(--border-default)]">
            <table className="min-w-full text-body-sm">
              <thead>
                <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)]">
                  {[
                    "Code",
                    "Name",
                    "Doc Type",
                    "Posting Nature",
                    "Auto-Post Limit (MYR)",
                    "Approval Required When",
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
                {activeReasonCodes.map((rc) => {
                  const limitNum = parseFloat(rc.autoPostLimit);
                  const alwaysApproval = limitNum === 0;
                  return (
                    <tr
                      key={rc.reasonCode}
                      className="bg-[color:var(--surface-card)]"
                    >
                      <td className="px-4 py-2 font-mono font-semibold text-foreground">
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
                        {alwaysApproval ? (
                          <span className="text-muted-foreground">
                            0 (always approval)
                          </span>
                        ) : (
                          rc.autoPostLimit
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {alwaysApproval
                          ? "Always"
                          : `Amount > ${rc.autoPostLimit}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Live bill cycles with term resolution ─────────────────────────── */}
      <section className="space-y-3" aria-labelledby="bc-heading">
        <h2 id="bc-heading" className="text-h3 font-semibold text-foreground">
          Active Bill Cycles &amp; Term Resolution
        </h2>
        <p className="text-body-sm text-muted-foreground">
          Payment due days are the cycle default for term resolution (V10):{" "}
          <code className="font-mono">
            resolveTerm(banOverride, cycle.paymentDueDays)
          </code>
          . Terms are frozen at document issuance; changing the cycle default
          after issuance does not move already-stamped due dates (Inv. #13).
        </p>
        {activeBillCycles.length === 0 ? (
          <p className="text-body text-muted-foreground">
            No active bill cycles.{" "}
            <Link
              href="/administration/accounts-settings"
              className="text-[color:var(--action-primary-bg)] hover:underline"
            >
              Add one in Settings.
            </Link>
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-[color:var(--border-default)]">
            <table className="min-w-full text-body-sm">
              <thead>
                <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)]">
                  {[
                    "Cycle Name",
                    "Frequency",
                    "Cycle Day",
                    "Default Due Days",
                    "Override Wins?",
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
                {activeBillCycles.map((bc) => (
                  <tr
                    key={bc.billCycleId}
                    className="bg-[color:var(--surface-card)]"
                  >
                    <td className="px-4 py-2 font-medium text-foreground">
                      {bc.name}
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
                    <td className="px-4 py-2 text-muted-foreground">
                      Yes — BAN-level override takes precedence
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Term resolution rule ─────────────────────────────────────────── */}
      <section
        className="space-y-2 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)] p-4"
        aria-labelledby="term-rule-heading"
      >
        <h2
          id="term-rule-heading"
          className="text-body font-semibold text-foreground"
        >
          Term Resolution Rule (V10 / Inv. #13)
        </h2>
        <pre className="font-mono text-body-sm whitespace-pre-wrap text-foreground">
          {`resolveTerm(banOverride, cycleDefault):
  if banOverride is set → use banOverride
  else                  → use cycleDefault

Frozen at document issuance. Post-issuance changes to either value do not
affect already-stamped due dates on issued documents.`}
        </pre>
      </section>
    </main>
  );
}

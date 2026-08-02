import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { GlCodeForm } from "@/components/accounts/gl-code-form";
import { GlMappingForm } from "@/components/accounts/gl-mapping-form";
import { RetireGlCodeButton } from "@/components/accounts/retire-gl-buttons";
import { RetireGlMappingButton } from "@/components/accounts/retire-gl-buttons";
import { meetsLevel } from "@/types/permissions";
import {
  getGlAccountTree,
  getGlAccount,
  type GlAccountNode,
} from "@/services/accounts/gl-account";
import { listGlMappings } from "@/services/accounts/gl-mapping";
import { getGlHealth } from "@/services/accounts/gl-health";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Chart of Accounts" };

const CLASS_LABELS: Record<string, string> = {
  asset: "Asset",
  liability: "Liability",
  equity: "Equity",
  revenue: "Revenue",
  expense: "Expense",
};

const CLASS_COLORS: Record<string, string> = {
  asset: "bg-[color:var(--color-cyan-50)] text-[color:var(--color-cyan-700)]",
  liability:
    "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
  equity:
    "bg-[color:var(--color-primary-50)] text-[color:var(--color-primary-700)]",
  revenue:
    "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
  expense:
    "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]",
};

function ClassChip({ cls }: { cls: string }): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase ${CLASS_COLORS[cls] ?? ""}`}
    >
      {CLASS_LABELS[cls] ?? cls}
    </span>
  );
}

function NormalBalanceChip({
  balance,
}: {
  balance: string;
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center rounded-full bg-[color:var(--color-neutral-100)] px-2 py-0.5 text-[10px] font-semibold tracking-wider text-[color:var(--color-neutral-600)] uppercase">
      {balance === "debit" ? "Dr" : "Cr"}
    </span>
  );
}

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

// Pre-computed left-padding classes for each tree depth (12 + depth×16 px).
// Using a lookup avoids dynamic class generation which Tailwind cannot purge.
const DEPTH_PL: Record<number, string> = {
  0: "pl-3",
  1: "pl-7",
  2: "pl-11",
  3: "pl-[60px]",
  4: "pl-[76px]",
};

function CoaNode({
  node,
  depth,
  selectedGl,
  baseHref,
}: {
  node: GlAccountNode;
  depth: number;
  selectedGl: string | undefined;
  baseHref: string;
}): React.JSX.Element {
  const isSelected = node.glCode === selectedGl;
  const isRetired = node.state === "retired";

  return (
    <li>
      <Link
        href={`${baseHref}&gl=${node.glCode}`}
        aria-current={isSelected ? "true" : undefined}
        className={[
          "flex items-center gap-2 py-1.5 pr-3 text-body-sm transition-colors hover:bg-[color:var(--surface-sunken)]",
          DEPTH_PL[depth] ?? "pl-[92px]",
          isSelected ? "bg-[color:var(--acct-context-strip-bg)]" : "",
          isRetired ? "opacity-50" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground">
          {node.glCode}
        </span>
        <span className="flex-1 text-foreground">{node.name}</span>
        <ClassChip cls={node.accountClass} />
        <NormalBalanceChip balance={node.normalBalance} />
        {!node.isPostable && (
          <span className="text-[10px] text-muted-foreground italic">
            summary
          </span>
        )}
        {isRetired && <StateChip state="retired" />}
      </Link>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <CoaNode
              key={child.glCode}
              node={child}
              depth={depth + 1}
              selectedGl={selectedGl}
              baseHref={baseHref}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default async function ChartOfAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { permissionMap } = await requirePermission(
    PERMISSIONS.ACCOUNTS_CONFIG,
    LEVELS.READ,
  );

  const canEdit = meetsLevel(permissionMap.accounts_config, LEVELS.EDIT);

  const params = await searchParams;
  const selectedGl = typeof params.gl === "string" ? params.gl : undefined;

  const [tree, allMappings, health] = await Promise.all([
    getGlAccountTree(),
    listGlMappings(),
    getGlHealth(),
  ]);

  const selectedAccount = selectedGl ? await getGlAccount(selectedGl) : null;

  // Build flat list from tree for form selectors.
  function flatten(nodes: GlAccountNode[]): GlAccountNode[] {
    return nodes.flatMap((n) => [n, ...flatten(n.children)]);
  }
  const allAccounts = flatten(tree);
  const activeAccounts = allAccounts.filter((a) => a.state === "active");
  const postableAccounts = activeAccounts.filter((a) => a.isPostable);

  // Where-used: active mappings that target the selected GL code.
  const whereUsedMappings = selectedGl
    ? allMappings.filter(
        (m) => m.refGlCode === selectedGl && m.state === "active",
      )
    : [];

  // Base href preserves the ?gl= param across navigations.
  const baseHref = "/accounts/chart-of-accounts?";

  const activeMappings = allMappings.filter((m) => m.state === "active");
  const retiredMappings = allMappings.filter((m) => m.state === "retired");

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">
          Chart of Accounts
        </h1>
        <p className="mt-1 text-body text-muted-foreground">
          GL code hierarchy, mapping rules, and GL resolution health.
        </p>
      </header>

      {/* ── Health Panel (V5) ─────────────────────────────────────────────── */}
      <div
        role={health.unmappedCount === 0 ? "status" : "alert"}
        className={[
          "flex items-center gap-3 rounded-none px-4 py-2.5 text-body-sm font-medium",
          health.unmappedCount === 0
            ? "bg-[color:var(--acct-balance-ok)] text-white"
            : "bg-[color:var(--acct-balance-broken)] text-white",
        ].join(" ")}
      >
        {health.unmappedCount === 0 ? (
          <span>
            GL resolution OK — all pgledger accounts map to a postable GL code.
          </span>
        ) : (
          <span>
            {health.unmappedCount} unmapped account
            {health.unmappedCount !== 1 ? "s" : ""}:{" "}
            {health.unmappedAccounts.join(", ")} — journal export will be
            corrupt until resolved.
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
        {/* ── CoA Tree ──────────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-h3 font-semibold text-foreground">
              GL Accounts
            </h2>
            {canEdit && <GlCodeForm activeAccounts={activeAccounts} />}
          </div>

          <div className="overflow-hidden rounded-md border border-[color:var(--border-default)]">
            {tree.length === 0 ? (
              <p className="px-4 py-6 text-body text-muted-foreground">
                No GL accounts seeded yet.
              </p>
            ) : (
              <ul className="divide-y divide-[color:var(--border-subtle)]">
                {tree.map((node) => (
                  <CoaNode
                    key={node.glCode}
                    node={node}
                    depth={0}
                    selectedGl={selectedGl}
                    baseHref={baseHref}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* ── GL Code Detail Panel ──────────────────────────────────────────── */}
        {selectedAccount ? (
          <aside className="space-y-4">
            <h2 className="text-h3 font-semibold text-foreground">
              GL Code Detail
            </h2>
            <div className="rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)]">
              <div className="space-y-3 border-b border-[color:var(--border-subtle)] px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-h3 font-semibold text-foreground">
                    {selectedAccount.glCode}
                  </span>
                  <StateChip state={selectedAccount.state} />
                </div>
                <p className="text-body text-foreground">
                  {selectedAccount.name}
                </p>
                <div className="flex flex-wrap gap-2">
                  <ClassChip cls={selectedAccount.accountClass} />
                  <NormalBalanceChip balance={selectedAccount.normalBalance} />
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase ${
                      selectedAccount.isPostable
                        ? "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]"
                        : "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]"
                    }`}
                  >
                    {selectedAccount.isPostable ? "Postable" : "Summary"}
                  </span>
                </div>
                {selectedAccount.parentGlCode && (
                  <p className="text-body-sm text-muted-foreground">
                    Parent:{" "}
                    <span className="font-mono">
                      {selectedAccount.parentGlCode}
                    </span>
                  </p>
                )}
              </div>

              {/* Where-used */}
              <div className="px-4 py-3">
                <p className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Where Used (active mappings)
                </p>
                {whereUsedMappings.length === 0 ? (
                  <p className="text-body-sm text-muted-foreground">
                    No active mapping rules target this code.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {whereUsedMappings.map((m) => (
                      <li
                        key={m.glMappingId}
                        className="text-body-sm text-foreground"
                      >
                        <span className="font-mono text-muted-foreground">
                          {m.selectorType}
                        </span>{" "}
                        / <span className="font-mono">{m.selector}</span>
                        {m.currency && (
                          <span className="ml-1 text-muted-foreground">
                            ({m.currency})
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Retire action */}
              {canEdit && selectedAccount.state === "active" && (
                <div className="border-t border-[color:var(--border-subtle)] px-4 py-3">
                  <RetireGlCodeButton
                    glCode={selectedAccount.glCode}
                    lastModified={selectedAccount.lastModified.toISOString()}
                  />
                </div>
              )}
            </div>
          </aside>
        ) : (
          <aside className="hidden lg:block">
            <p className="mt-10 text-center text-body-sm text-muted-foreground">
              Select a GL code from the tree to see its detail and where-used.
            </p>
          </aside>
        )}
      </div>

      {/* ── Mapping Rules ─────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-h3 font-semibold text-foreground">
            GL Mapping Rules
          </h2>
          {canEdit && <GlMappingForm postableAccounts={postableAccounts} />}
        </div>

        {/* Active mappings */}
        <div className="overflow-x-auto rounded-md border border-[color:var(--border-default)]">
          <table className="min-w-full text-body-sm">
            <thead>
              <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)]">
                <th className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  ID
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Type
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Selector
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Currency
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  Target GL
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  State
                </th>
                {canEdit && (
                  <th className="px-4 py-2 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--border-subtle)]">
              {activeMappings.length === 0 ? (
                <tr>
                  <td
                    colSpan={canEdit ? 7 : 6}
                    className="px-4 py-6 text-center text-muted-foreground"
                  >
                    No active mapping rules.
                  </td>
                </tr>
              ) : (
                activeMappings.map((m) => (
                  <tr
                    key={m.glMappingId}
                    className="bg-[color:var(--surface-card)] hover:bg-[color:var(--surface-sunken)]"
                  >
                    <td className="px-4 py-2 font-mono text-muted-foreground">
                      {m.glMappingId}
                    </td>
                    <td className="px-4 py-2 text-foreground">
                      {m.selectorType === "ledger_role"
                        ? "Role"
                        : "System Account"}
                    </td>
                    <td className="px-4 py-2 font-mono text-foreground">
                      {m.selector}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {m.currency ?? "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-foreground">
                      {m.refGlCode}
                    </td>
                    <td className="px-4 py-2">
                      <StateChip state={m.state} />
                    </td>
                    {canEdit && (
                      <td className="px-4 py-2">
                        <RetireGlMappingButton
                          glMappingId={m.glMappingId}
                          lastModified={m.lastModified.toISOString()}
                        />
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Retired mappings (collapsed disclosure) */}
        {retiredMappings.length > 0 && (
          <details className="rounded-md border border-[color:var(--border-default)]">
            <summary className="cursor-pointer px-4 py-2 text-body-sm text-muted-foreground hover:bg-[color:var(--surface-sunken)]">
              {retiredMappings.length} retired mapping
              {retiredMappings.length !== 1 ? "s" : ""} (kept for history)
            </summary>
            <div className="overflow-x-auto">
              <table className="min-w-full text-body-sm">
                <tbody className="divide-y divide-[color:var(--border-subtle)]">
                  {retiredMappings.map((m) => (
                    <tr
                      key={m.glMappingId}
                      className="bg-[color:var(--surface-card)] opacity-60"
                    >
                      <td className="px-4 py-2 font-mono text-muted-foreground">
                        {m.glMappingId}
                      </td>
                      <td className="px-4 py-2 text-foreground">
                        {m.selectorType === "ledger_role"
                          ? "Role"
                          : "System Account"}
                      </td>
                      <td className="px-4 py-2 font-mono text-foreground">
                        {m.selector}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {m.currency ?? "—"}
                      </td>
                      <td className="px-4 py-2 font-mono text-foreground">
                        {m.refGlCode}
                      </td>
                      <td className="px-4 py-2">
                        <StateChip state="retired" />
                      </td>
                      {canEdit && <td className="px-4 py-2" />}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>
    </main>
  );
}

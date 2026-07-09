import type { Tier } from "@/validation/product/pricing-characteristics.schema";

type TierTableProps = {
  tiers: Tier[];
};

export function TierTable({ tiers }: TierTableProps): React.JSX.Element {
  return (
    <table className="w-full rounded-[var(--radius-none)] border border-[color:var(--border-subtle)] text-body-sm">
      <thead>
        <tr className="border-b border-[color:var(--border-subtle)]">
          <th
            scope="col"
            className="px-2 py-1 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase"
          >
            From
          </th>
          <th
            scope="col"
            className="px-2 py-1 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase"
          >
            To
          </th>
          <th
            scope="col"
            className="px-2 py-1 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Rate
          </th>
        </tr>
      </thead>
      <tbody>
        {tiers.map((tier, index) => (
          <tr
            key={index}
            className="border-b border-[color:var(--border-subtle)] last:border-b-0"
          >
            <td className="px-2 py-1 font-mono text-foreground tabular-nums">
              {String(tier.from)}
            </td>
            <td className="px-2 py-1 font-mono text-foreground tabular-nums">
              {tier.to === null ? "and above" : String(tier.to)}
            </td>
            <td className="px-2 py-1 font-mono text-foreground tabular-nums">
              {tier.rate}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

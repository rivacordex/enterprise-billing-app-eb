import { Settings } from "lucide-react";

import { ConfigEditDialog } from "@/components/system-config/config-edit-dialog";
import { ConfigStatusBadge } from "@/components/system-config/config-status-badge";
import { formatRelativeTime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { SystemConfigGroup } from "@/types/system-config";

interface ConfigTableProps {
  groups: SystemConfigGroup[];
  canEdit?: boolean;
}

const URI_PREFIXES = ["http://", "https://"];

// Renders the DB-sourced, non-secret config rows grouped by `config_group`
// (um22-spec §22.6.2). Receives pre-grouped, pre-ordered data — grouping
// happens in the page via `groupConfigRows`, not here. um23 adds the
// optional Actions column (`canEdit`) — each row's `ConfigEditDialog` is a
// Client Component leaf inserted into this otherwise-Server-Component tree.
export function ConfigTable({
  groups,
  canEdit = false,
}: ConfigTableProps): React.JSX.Element {
  const hasRows = groups.some((group) => group.rows.length > 0);

  if (!hasRows) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
        <Settings size={32} className="text-muted-foreground" />
        <h3 className="text-h4 font-semibold text-foreground">
          No configuration parameters
        </h3>
        <p className="text-body text-muted-foreground">
          No system parameters have been configured.
        </p>
      </div>
    );
  }

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
          <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
            Key
          </th>
          <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
            Value
          </th>
          <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
            Status
          </th>
          <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase">
            Last Modified
          </th>
          {canEdit && (
            <th className="w-12 px-4 py-3 text-right text-overline font-semibold tracking-wider text-[color:var(--color-neutral-800)] uppercase" />
          )}
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <SystemConfigGroupRows
            key={group.group}
            group={group}
            canEdit={canEdit}
          />
        ))}
      </tbody>
    </table>
  );
}

function SystemConfigGroupRows({
  group,
  canEdit,
}: {
  group: SystemConfigGroup;
  canEdit: boolean;
}): React.JSX.Element {
  return (
    <>
      <tr>
        <td
          colSpan={canEdit ? 5 : 4}
          className="bg-[color:var(--surface-sunken)] px-4 py-2 text-overline font-semibold tracking-wider text-muted-foreground uppercase"
        >
          {group.group}
        </td>
      </tr>
      {group.rows.map((row) => {
        const value = row.configValue ?? "";
        const isLong = value.length > 80;
        const isUri = URI_PREFIXES.some((prefix) => value.startsWith(prefix));

        return (
          <tr
            key={row.configId}
            className={cn(
              "border-b border-[color:var(--border-subtle)]",
              row.status === "RETIRED" && "opacity-60",
            )}
          >
            <td className="px-4 py-3 align-top">
              <div className="font-mono text-sm text-foreground">
                {row.configKey}
              </div>
              {/* um28-spec §2.10: the seeded description renders as a muted
                  second-line sublabel under the key (not a new column). Blank
                  ⇒ no sublabel (no placeholder). */}
              {row.description && (
                <p className="mt-0.5 text-caption text-[color:var(--text-muted)]">
                  {row.description}
                </p>
              )}
            </td>
            <td
              className={cn(
                "px-4 py-3",
                isLong && "max-w-xs truncate",
                isUri && "font-mono",
              )}
              title={isLong ? value : undefined}
            >
              {row.configValue ?? "—"}
            </td>
            <td className="px-4 py-3">
              <ConfigStatusBadge status={row.status} />
            </td>
            <td className="px-4 py-3">
              <time
                dateTime={row.lastModifiedDatetime.toISOString()}
                title={row.lastModifiedDatetime.toISOString()}
              >
                {formatRelativeTime(row.lastModifiedDatetime)}
              </time>
              {row.modifiedByName !== null && (
                <span className="ml-1 text-[color:var(--text-muted)]">
                  by {row.modifiedByName}
                </span>
              )}
            </td>
            {canEdit && (
              <td className="px-4 py-2 text-right">
                <ConfigEditDialog
                  configId={row.configId}
                  configKey={row.configKey}
                  configGroup={row.configGroup}
                  initialValue={row.configValue}
                />
              </td>
            )}
          </tr>
        );
      })}
    </>
  );
}

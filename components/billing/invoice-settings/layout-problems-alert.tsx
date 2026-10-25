// bm79 (ui-context §10e, Upload problems) — the Danger problems `Alert` from
// bm78's upload dialog, extracted unchanged so Activate can show it too: every
// problem in one alert, grouped by file (never a toast).

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { LayoutProblem } from "@/types/billing";

function groupByFile(
  problems: readonly LayoutProblem[],
): [string, LayoutProblem[]][] {
  const groups = new Map<string, LayoutProblem[]>();
  for (const p of problems) {
    const list = groups.get(p.file) ?? [];
    list.push(p);
    groups.set(p.file, list);
  }
  return [...groups];
}

export function LayoutProblemsAlert({
  title,
  problems,
}: {
  title: string;
  problems: readonly LayoutProblem[];
}): React.JSX.Element {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="space-y-2">
          {groupByFile(problems).map(([groupFile, list]) => (
            <li key={groupFile}>
              <span className="font-mono text-mono">{groupFile}</span>
              <ul className="ml-4 list-disc">
                {list.map((p, i) => (
                  <li key={`${p.code}-${i}`}>
                    <span className="font-mono text-mono">{p.code}</span> —{" "}
                    {p.message}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

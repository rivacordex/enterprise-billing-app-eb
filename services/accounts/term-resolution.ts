// ac04-spec §2.7 / Inv. #13 — single source for coalesce(override, cycle
// default). Pure function; no imports, no side effects. Every downstream
// surface that derives "resolved payment due days" (overdue badge in ac05,
// invoicing term stamp in future Invoicing) calls this, never re-implements
// the coalesce inline.
export function resolveTerm(
  override: number | null | undefined,
  cycleDefault: number,
): number {
  return override ?? cycleDefault;
}

// rating.udr_rated.udr_key — the raw key (Inv 27; rm25-spec). TypeScript
// mirror of PRP's `build_udr_key` (rm26): key column names sorted ascending,
// each written `name=value` with the value exactly as it arrived, joined by
// `|`. Values are never normalised. Key names are ASCII, so this code-unit
// sort and Python's code-point sort agree.
export function buildRawUdrKey(
  columns: Readonly<Record<string, string>>,
  keyColumns: readonly string[],
): string {
  return [...keyColumns]
    .sort()
    .map((name) => {
      if (!Object.hasOwn(columns, name)) {
        throw new Error(`udr_key column missing: ${name}`);
      }
      return `${name}=${columns[name]}`;
    })
    .join("|");
}

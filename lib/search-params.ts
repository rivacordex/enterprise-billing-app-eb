// Next.js delivers each searchParam as `string | string[] | undefined` (a key
// repeated in the query string arrives as an array). Server pages that parse a
// single-valued param collapse it to the first value before handing it to their
// Zod schema. Centralised here (pm39 review) so the ~9 pages that used to each
// declare an identical local copy share one definition.
export function firstValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

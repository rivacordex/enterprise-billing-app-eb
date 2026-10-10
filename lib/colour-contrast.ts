// bm59-spec §Design D3, ui-context §10b — WCAG 2.x contrast of white text on a
// `#RRGGBB` colour, for the profile form's non-blocking Warning hint (white
// below 4.5:1). Pure; `null` for anything that is not a 6-digit hex colour.
const HEX_RE = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/;

export const MIN_TEXT_CONTRAST = 4.5;

function channel(hex: string): number {
  const c = Number.parseInt(hex, 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function whiteTextContrast(colour: string): number | null {
  const m = HEX_RE.exec(colour);
  if (!m) return null;
  const [, r, g, b] = m as unknown as [string, string, string, string];
  const luminance =
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  // White's relative luminance is 1.
  return 1.05 / (luminance + 0.05);
}

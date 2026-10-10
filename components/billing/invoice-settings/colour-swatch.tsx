// bm56/bm59, ui-context §10b — the 20×20 colour swatch beside a profile colour
// (`--radius-xs`, `--border-default`). An inline `<svg>` because inline `style`
// props are lint-banned. Renders nothing for a value that is not `#RRGGBB`.
const COLOUR_RE = /^#[0-9A-Fa-f]{6}$/;

export function ColourSwatch({
  value,
}: {
  value: string | null | undefined;
}): React.JSX.Element | null {
  if (!value || !COLOUR_RE.test(value)) return null;
  return (
    <svg
      aria-hidden
      data-testid="colour-swatch"
      width={20}
      height={20}
      viewBox="0 0 20 20"
      className="shrink-0 rounded-xs border border-[color:var(--border-default)]"
    >
      <rect width={20} height={20} fill={value} />
    </svg>
  );
}

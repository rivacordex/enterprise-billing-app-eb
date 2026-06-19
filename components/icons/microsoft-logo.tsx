// um10-spec §"Sign-in entry point" — official 4-color Microsoft logo
// (a 2×2 grid of squares), 16×16, inline so no extra network request is
// needed for a single icon on the login page.
export function MicrosoftLogo(): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0" y="0" width="7" height="7" fill="#F25022" />
      <rect x="9" y="0" width="7" height="7" fill="#7FBA00" />
      <rect x="0" y="9" width="7" height="7" fill="#00A4EF" />
      <rect x="9" y="9" width="7" height="7" fill="#FFB900" />
    </svg>
  );
}

// Shared by the pm45 guardrail sweeps (status-literal-sweep.test.ts,
// product-lifecycle-transitions.test.ts). Removes line and block comments while
// preserving string/template literals, so a scan reacts to real code — not a
// comment that merely NAMES an identifier or a quoted literal (e.g.
// product-offering.ts's own §1.15 note spelling `setLifecycleStatus`, or
// offering-table.tsx's comment `=== 'RETIRED'`).
//
// The alternation matches a whole string/template literal FIRST and returns it
// untouched, so a `//` inside a string is never read as a comment.
//
// KNOWN LIMITATION: it does not model regex literals or division, so a lone
// apostrophe inside a regex (e.g. `/it's/`) followed later by a `//` comment can
// mis-span. No scanned production file triggers this today; a full JS tokenizer
// is deliberately out of scope for a guardrail. If a future file combines an
// apostrophe-bearing regex with a later comment naming a status literal, harden
// here (one place, both sweeps).
export function stripComments(source: string): string {
  return source.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, stringLiteral: string | undefined) => (stringLiteral ? match : ""),
  );
}

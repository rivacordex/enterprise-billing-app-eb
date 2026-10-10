// bm60-spec §Design D4, code-standards Part 2 data rule 9 — the SVG content
// policy: REJECT, NEVER REPAIR. Nothing is stripped; a stripped SVG would be a
// different artifact from the one the admin previewed, so the stored bytes are
// exactly the uploaded bytes. Defense in depth: the invoice embeds the logo
// only as `<img src="data:image/svg+xml;base64,…">` (bm53 D4, scripts never
// run), and the GET route serves it with CSP `sandbox` + `nosniff` (bm56 D3).

interface Rule {
  construct: string;
  re: RegExp;
}

// A reference value that does not start with `#` (quoted or bare).
const NON_FRAGMENT = String.raw`\s*=\s*(?:"\s*(?!#)|'\s*(?!#)|(?!["'#]))`;

const RULES: readonly Rule[] = [
  { construct: "<script>", re: /<script\b/i },
  { construct: "<foreignObject>", re: /<foreignObject\b/i },
  { construct: "<iframe>", re: /<iframe\b/i },
  { construct: "<embed>", re: /<embed\b/i },
  { construct: "<object>", re: /<object\b/i },
  {
    construct: "<use> with an external reference",
    re: new RegExp(
      String.raw`<use\b[^>]*\b(?:xlink:)?href${NON_FRAGMENT}`,
      "i",
    ),
  },
  {
    construct: "<image> with an external href",
    re: new RegExp(
      String.raw`<image\b[^>]*\b(?:xlink:)?href${NON_FRAGMENT}`,
      "i",
    ),
  },
  { construct: "an on* event handler", re: /\bon[a-z]+\s*=/i },
  {
    construct: "an external href",
    re: new RegExp(String.raw`\b(?:xlink:)?href${NON_FRAGMENT}`, "i"),
  },
  {
    construct: "an external url()",
    re: /url\(\s*(?:["']\s*)?(?!#)/i,
  },
  { construct: "javascript:", re: /javascript:/i },
  { construct: "data:", re: /data:/i },
  { construct: "<!DOCTYPE>", re: /<!DOCTYPE/i },
  { construct: "<!ENTITY>", re: /<!ENTITY/i },
  { construct: "@import", re: /@import/i },
  {
    construct: "<style> with url() or @import",
    re: /<style\b[^>]*>(?:(?!<\/style)[\s\S])*(?:url\(|@import)/i,
  },
];

// The first offending construct (the earliest in the text), or `null` when
// the SVG is acceptable.
export function findSvgViolation(text: string): string | null {
  let first: { index: number; construct: string } | null = null;
  for (const { construct, re } of RULES) {
    const m = re.exec(text);
    if (m && (first === null || m.index < first.index)) {
      first = { index: m.index, construct };
    }
  }
  return first?.construct ?? null;
}

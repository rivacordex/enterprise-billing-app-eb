// bm60-spec §Design D4, code-standards Part 2 data rule 9 — the SVG content
// policy: REJECT, NEVER REPAIR. Nothing is stripped; a stripped SVG would be a
// different artifact from the one the admin previewed, so the stored bytes are
// exactly the uploaded bytes. Defense in depth: the invoice embeds the logo
// only as `<img src="data:image/svg+xml;base64,…">` (bm53 D4, scripts never
// run), and the GET route serves it with CSP `sandbox` + `nosniff` (bm56 D3).
//
// A hand-written scanner, linear in the text: every check walks it once, and
// a tag's end, its `</style>` and the references inside it are found with
// forward-only pointers. (The regexes this replaces backtracked — a crafted
// ~500 KB SVG could hold the event loop, so every user's request, for
// minutes.) Case-insensitive, like the regexes. An element is matched by its
// LOCAL name, so a namespace prefix (`<s:script>`) does not hide it.

// Earlier entries win when two constructs start at the same index.
const CONSTRUCTS = [
  "<script>",
  "<foreignObject>",
  "<iframe>",
  "<embed>",
  "<object>",
  "<use> with an external reference",
  "<image> with an external href",
  "an on* event handler",
  "an external href",
  "an external url()",
  "javascript:",
  "data:",
  "<!DOCTYPE>",
  "<!ENTITY>",
  "@import",
  "<style> with url() or @import",
] as const;
type Construct = (typeof CONSTRUCTS)[number];

// Matched in this order; `use`, `image` and `style` are checked for what they
// contain.
const ELEMENTS: ReadonlyArray<readonly [string, Construct | null]> = [
  ["script", "<script>"],
  ["foreignobject", "<foreignObject>"],
  ["iframe", "<iframe>"],
  ["embed", "<embed>"],
  ["object", "<object>"],
  ["use", null],
  ["image", null],
  ["style", null],
];

const BANNED_TEXT: ReadonlyArray<readonly [string, Construct]> = [
  ["javascript:", "javascript:"],
  ["data:", "data:"],
  ["<!doctype", "<!DOCTYPE>"],
  ["<!entity", "<!ENTITY>"],
  ["@import", "@import"],
];

const SPACE = /\s/;
const WORD = /\w/;
const NAME_CHAR = /[\w.:·-￿-]/;

function isSpace(c: string | undefined): boolean {
  return c !== undefined && SPACE.test(c);
}

function isWord(c: string | undefined): boolean {
  return c !== undefined && WORD.test(c);
}

function skipSpace(s: string, i: number): number {
  while (isSpace(s[i])) i++;
  return i;
}

// Every index of `needle` in `s`, ascending.
function indexesOf(s: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = s.indexOf(needle); i !== -1; i = s.indexOf(needle, i + 1)) {
    out.push(i);
  }
  return out;
}

// The element named by the tag name at `i`, or `null`. A name matches as a
// whole word (`<script>`, `<script/`, `<script-x`, as `\b` did) either at the
// start of the tag name or after its namespace prefix (`<s:script>`).
function elementAt(s: string, i: number): string | null {
  let end = i;
  let local = i;
  while (end < s.length && NAME_CHAR.test(s[end]!)) {
    if (s[end] === ":") local = end + 1;
    end++;
  }
  for (const [name] of ELEMENTS) {
    for (const at of local === i ? [i] : [i, local]) {
      if (s.startsWith(name, at) && !isWord(s[at + name.length])) return name;
    }
  }
  return null;
}

// Whether the reference value at `i` is NOT a `#fragment`: skip spaces, one
// optional quote and spaces again, then anything but `#` is external
// (`url( '#g')` and `href=" #a"` are fragments).
function isExternalAt(s: string, i: number): boolean {
  i = skipSpace(s, i);
  if (s[i] === '"' || s[i] === "'") i = skipSpace(s, i + 1);
  return s[i] !== "#";
}

// `href` (any prefix: `xlink:href`, `x:href`) followed by `=` and an
// external value.
function externalHrefs(s: string): number[] {
  return indexesOf(s, "href").filter((i) => {
    if (isWord(s[i - 1])) return false;
    const eq = skipSpace(s, i + 4);
    return s[eq] === "=" && isExternalAt(s, eq + 1);
  });
}

// `on` + at least one letter + `=` (spaces allowed before the `=`).
function firstEventHandler(s: string): number {
  for (const i of indexesOf(s, "on")) {
    if (isWord(s[i - 1])) continue;
    let j = i + 2;
    while (j < s.length && s[j]! >= "a" && s[j]! <= "z") j++;
    if (j > i + 2 && s[skipSpace(s, j)] === "=") return i;
  }
  return -1;
}

// The first offending construct (the earliest in the text), or `null` when
// the SVG is acceptable.
export function findSvgViolation(text: string): string | null {
  const s = text.toLowerCase();
  const hits = new Map<Construct, number>();
  const note = (construct: Construct, index: number): void => {
    if (index !== -1 && !hits.has(construct)) hits.set(construct, index);
  };

  for (const [needle, construct] of BANNED_TEXT) {
    note(construct, s.indexOf(needle));
  }
  note("an on* event handler", firstEventHandler(s));

  const hrefs = externalHrefs(s);
  note("an external href", hrefs[0] ?? -1);

  const urls = indexesOf(s, "url(");
  note("an external url()", urls.find((i) => isExternalAt(s, i + 4)) ?? -1);

  // Inside `<style>`, even a fragment `url(#g)` is refused, as is `@import`.
  const cssRefs = [...urls, ...indexesOf(s, "@import")].sort((a, b) => a - b);
  const styleCloses = indexesOf(s, "</").filter(
    (i) => elementAt(s, i + 2) === "style",
  );

  // Forward-only pointers: tags are visited in ascending order, so a tag's
  // end, its `</style>` and the next reference never move backwards.
  let tagEnd = -1;
  let hrefAt = 0;
  let cssAt = 0;
  let closeAt = 0;
  for (const lt of indexesOf(s, "<")) {
    const local = elementAt(s, lt + 1);
    if (local === null) continue;
    const banned = ELEMENTS.find(([name]) => name === local)?.[1];
    if (banned) {
      note(banned, lt);
      continue;
    }

    if (tagEnd <= lt) {
      tagEnd = s.indexOf(">", lt);
      if (tagEnd === -1) tagEnd = s.length;
    }
    if (local === "style") {
      if (tagEnd === s.length) continue;
      while (closeAt < styleCloses.length && styleCloses[closeAt]! <= tagEnd) {
        closeAt++;
      }
      const close = styleCloses[closeAt] ?? s.length;
      while (cssAt < cssRefs.length && cssRefs[cssAt]! <= tagEnd) cssAt++;
      if ((cssRefs[cssAt] ?? s.length) < close) {
        note("<style> with url() or @import", lt);
      }
      continue;
    }
    while (hrefAt < hrefs.length && hrefs[hrefAt]! <= lt) hrefAt++;
    if ((hrefs[hrefAt] ?? s.length) < tagEnd) {
      note(
        local === "use"
          ? "<use> with an external reference"
          : "<image> with an external href",
        lt,
      );
    }
  }

  let first: { index: number; construct: Construct } | null = null;
  for (const construct of CONSTRUCTS) {
    const index = hits.get(construct);
    if (index !== undefined && (first === null || index < first.index)) {
      first = { index, construct };
    }
  }
  return first?.construct ?? null;
}

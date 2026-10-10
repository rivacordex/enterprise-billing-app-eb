import type { LogoMimeType } from "@/types/billing";

// bm60-spec §Design D2 check 2 + D3 — type detection and dimensions WITHOUT an
// image library (`sharp` is only an optional transitive of `next`; adding a
// dependency is a stop-and-ask, workflow rules §6.13). Every parser is pure,
// bounds-checked (never reads past the buffer) and returns a typed result —
// hostile or truncated input never throws.

export type DimensionsResult =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: "mime" | "dimensions"; message: string };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Buffer, prefix: readonly number[]): boolean {
  return (
    bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b)
  );
}

// Strict UTF-8 decode; `null` when the bytes are not valid UTF-8.
export function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// The offset of the root `<svg` in `text`, after an optional BOM, whitespace,
// the `<?xml …?>` declaration, comments and a `<!DOCTYPE …>` (skipped here so
// the content policy can reject it by name, D4), or `-1`.
export function svgRootOffset(text: string): number {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith("<?xml", i)) {
      const end = text.indexOf("?>", i);
      if (end < 0) return -1;
      i = end + 2;
    } else if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) return -1;
      i = end + 3;
    } else if (/^<!doctype/i.test(text.slice(i, i + 9))) {
      const bracket = text.indexOf("[", i);
      const close = text.indexOf(">", i);
      if (close < 0) return -1;
      const end =
        bracket >= 0 && bracket < close ? text.indexOf("]>", bracket) : close;
      if (end < 0) return -1;
      i = end + (end === close ? 1 : 2);
    } else {
      return /^<svg[\s/>]/.test(text.slice(i, i + 5)) ? i : -1;
    }
  }
}

// D2 check 2 — the type the bytes really are, or `null`.
export function detectImageType(bytes: Buffer): LogoMimeType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  const text = decodeUtf8(bytes);
  return text !== null && svgRootOffset(text) >= 0 ? "image/svg+xml" : null;
}

// PNG: `IHDR` must be the first chunk (offset 8, length 13); width and height
// are UInt32BE at 16 and 20.
export function pngDimensions(bytes: Buffer): DimensionsResult {
  if (
    bytes.length < 24 ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("latin1", 12, 16) !== "IHDR"
  ) {
    return { ok: false, reason: "mime", message: "PNG has no valid IHDR" };
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    return { ok: false, reason: "mime", message: "PNG has a zero dimension" };
  }
  return { ok: true, width, height };
}

// SOF0–3, 5–7, 9–11, 13–15 (C4 DHT, C8 JPG and CC DAC are not frames).
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

// JPEG: walk the markers from offset 2 until the first SOF (height at +5,
// width at +7); stop at SOS/EOI or the buffer end.
export function jpegDimensions(bytes: Buffer): DimensionsResult {
  const fail: DimensionsResult = {
    ok: false,
    reason: "mime",
    message: "JPEG has no frame header",
  };
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return fail;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return fail;
    const length = bytes.readUInt16BE(i + 2);
    if (length < 2) return fail;
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > bytes.length) return fail;
      const height = bytes.readUInt16BE(i + 5);
      const width = bytes.readUInt16BE(i + 7);
      if (width === 0 || height === 0) return fail;
      return { ok: true, width, height };
    }
    i += 2 + length;
  }
  return fail;
}

const ATTR_RE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const LENGTH_RE = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*(px)?\s*$/i;

// The root `<svg …>` start tag's attributes (quoted values may contain `>`).
function rootAttributes(text: string, offset: number): Map<string, string> {
  const attrs = new Map<string, string>();
  let end = offset;
  let quote: string | null = null;
  for (; end < text.length; end++) {
    const c = text[end]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") break;
  }
  for (const m of text.slice(offset + 4, end).matchAll(ATTR_RE)) {
    attrs.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? "");
  }
  return attrs;
}

// SVG: `width`/`height` when both are plain numbers or `…px`; any other unit
// (`pt`, `em`, `%`, `mm`, …) is refused; else the `viewBox`'s 3rd/4th numbers.
export function svgDimensions(text: string): DimensionsResult {
  const offset = svgRootOffset(text);
  if (offset < 0) {
    return { ok: false, reason: "mime", message: "No root <svg> element" };
  }
  const attrs = rootAttributes(text, offset);
  const w = attrs.get("width");
  const h = attrs.get("height");
  if (w !== undefined && h !== undefined) {
    const wm = LENGTH_RE.exec(w);
    const hm = LENGTH_RE.exec(h);
    if (!wm || !hm) {
      return {
        ok: false,
        reason: "dimensions",
        message: "SVG width/height must be unitless or px",
      };
    }
    return positive(Number(wm[1]), Number(hm[1]));
  }
  const viewBox = attrs.get("viewbox");
  const parts =
    viewBox
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    return positive(parts[2]!, parts[3]!);
  }
  return {
    ok: false,
    reason: "dimensions",
    message: "SVG must declare width/height or viewBox",
  };
}

function positive(width: number, height: number): DimensionsResult {
  const w = Math.round(width);
  const h = Math.round(height);
  if (!(w > 0 && h > 0)) {
    return {
      ok: false,
      reason: "dimensions",
      message: "SVG dimensions must be positive",
    };
  }
  return { ok: true, width: w, height: h };
}

export function imageDimensions(
  type: LogoMimeType,
  bytes: Buffer,
): DimensionsResult {
  if (type === "image/png") return pngDimensions(bytes);
  if (type === "image/jpeg") return jpegDimensions(bytes);
  const text = decodeUtf8(bytes);
  return text === null
    ? { ok: false, reason: "mime", message: "SVG is not valid UTF-8" }
    : svgDimensions(text);
}

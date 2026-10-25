import { withHardenedPage } from "@/services/billing/render-invoice";
import type {
  ComplianceSectionKey,
  VisibleSectionReader,
  VisibleSectionReport,
} from "@/services/billing/invoice-template/compliance";

// bm76 — the visible tier's Chromium reader, through bm75's hardened context (JS off,
// offline, fetches aborted; `page.evaluate` still runs). innerText excludes comments,
// display:none, visibility:hidden and [hidden] (verified 2026-10-25).
//
// Code review fixes (2026-10-25):
// - the section is `section.sec.sec--<key>` (the element the static tier checks), and
//   every match is counted, so a decoy `.sec--<key>` cannot stand in for it;
// - a value is legible only if at least one text node containing it is RENDERED (has
//   client rects, passes checkVisibility) with effective opacity ≥ 0.1 (the PRODUCT up
//   to the root, so nested or shell-level opacity counts) and its own computed font
//   size ≥ 6px (computed size already reflects inheritance, so a `font-size:0`
//   container with sized children is fine). A value split across text nodes has no
//   single occurrence and is reported illegible (conservative);
// - the page code is a plain string evaluated in ONE round trip: a function compiled by
//   tsx/esbuild (keepNames) would carry `__name(...)` calls the page does not define.
// Known limits (accepted, the human preview stays the final check): same-colour text,
// clipping and off-screen positioning are not detected.
const READ_SECTIONS_SCRIPT = String.raw`(probes) => {
  var squash = function (t) { return String(t || "").replace(/\s+/g, " ").trim(); };
  var legible = function (textNode) {
    var parent = textNode.parentElement;
    if (!parent) return false;
    var range = document.createRange();
    range.selectNodeContents(textNode);
    if (range.getClientRects().length === 0) return false;
    if (!parent.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    if (Number(getComputedStyle(parent).fontSize.replace("px", "")) < 6) return false;
    var opacity = 1;
    for (var node = parent; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity >= 0.1;
  };
  var out = {};
  probes.forEach(function (probe) {
    var matches = document.querySelectorAll("section.sec.sec--" + probe.key);
    var el = matches[0];
    if (!el) {
      out[probe.key] = { present: false, count: 0, text: "", illegible: [] };
      return;
    }
    var illegible = probe.values.filter(function (value) {
      var needle = squash(value);
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (var n = walker.nextNode(); n; n = walker.nextNode()) {
        if (squash(n.textContent).indexOf(needle) !== -1 && legible(n)) return false;
      }
      return true;
    });
    out[probe.key] = { present: true, count: matches.length, text: el.innerText, illegible: illegible };
  });
  return out;
}`;

export const readSectionsVisibly: VisibleSectionReader = async (
  html,
  probes,
) => {
  const { value } = await withHardenedPage(html, (page) =>
    page.evaluate<Record<ComplianceSectionKey, VisibleSectionReport>>(
      `(${READ_SECTIONS_SCRIPT})(${JSON.stringify(probes)})`,
    ),
  );
  return value;
};

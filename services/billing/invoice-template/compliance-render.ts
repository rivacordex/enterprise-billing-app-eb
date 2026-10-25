import { withHardenedPage } from "@/services/billing/render-invoice";
import type {
  ComplianceSectionKey,
  VisibleSectionReader,
  VisibleSectionReport,
} from "@/services/billing/invoice-template/compliance";

// bm76 — the visible tier's Chromium reader, through bm75's hardened context (JS off,
// offline, fetches aborted). innerText excludes comments, display:none, visibility:hidden
// and [hidden] (verified 2026-10-25); the evaluate step adds opacity and font-size.
export const readSectionsVisibly: VisibleSectionReader = async (
  html,
  probes,
) => {
  const { value } = await withHardenedPage(html, async (page) => {
    const out = {} as Record<ComplianceSectionKey, VisibleSectionReport>;
    for (const { key, values } of probes) {
      const loc = page.locator(`.sec--${key}`).first();
      const present = (await page.locator(`.sec--${key}`).count()) > 0;
      const text = present ? await loc.innerText() : "";
      const illegible = present
        ? await loc.evaluate((el, vals) => {
            // For each value, take the parent element of the first text node
            // whose text contains it, and walk up to (and including) the
            // section: any element with opacity < 0.1 or font-size < 6px on
            // the way makes the value illegible.
            const squash = (t: string) => t.replace(/\s+/g, " ").trim();
            const illegibleAt = (start: Element): boolean => {
              let node: Element | null = start;
              while (node) {
                const style = getComputedStyle(node);
                if (
                  Number.parseFloat(style.opacity) < 0.1 ||
                  Number.parseFloat(style.fontSize) < 6
                ) {
                  return true;
                }
                if (node === el) break;
                node = node.parentElement;
              }
              return false;
            };
            return vals.filter((v) => {
              const needle = squash(v);
              const walker = document.createTreeWalker(
                el,
                NodeFilter.SHOW_TEXT,
              );
              for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                if (squash(n.textContent ?? "").includes(needle)) {
                  const parent = n.parentElement;
                  return parent ? illegibleAt(parent) : false;
                }
              }
              return false;
            });
          }, values as string[])
        : [];
      out[key] = { present, text, illegible };
    }
    return out;
  });
  return value;
};

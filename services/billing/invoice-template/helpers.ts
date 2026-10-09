import type Handlebars from "handlebars";

import { formatCalendarDate, formatCurrency } from "@/lib/formatters";
import { InvoiceRenderError } from "@/types/billing";
import type { InvoiceRenderInput } from "@/types/billing";

// bm47-spec §Design D6 — exactly the nine helpers, each a pure wrapper over
// the existing `formatCurrency`/`formatCalendarDate`. Helpers read
// `locale`/`currency` from `options.data.root` (the bound `InvoiceRenderInput`
// Handlebars renders against), never from config (code-standards TS rule 4).
// No helper returns `SafeString` — the layout lint (D10) forbids `{{{`.
export const KNOWN_HELPERS = {
  money: true,
  date: true,
  period: true,
  qty: true,
  price: true,
  int: true,
  amt: true,
  unitCode: true,
  asset: true,
} as const;

// UN/ECE rec 20 — fixed table (D6); unrecognised units render as-is.
const UNIT_CODE_MAP: Record<string, string> = {
  EA: "EA",
  GB: "E34",
  MB: "4L",
  MIN: "MIN",
  HR: "HUR",
};

function rootOf(options: Handlebars.HelperOptions): InvoiceRenderInput {
  return options.data.root as InvoiceRenderInput;
}

function isZeroString(value: string): boolean {
  return /^-?0+(\.0+)?$/.test(value.trim());
}

function formatNumberString(
  value: string,
  locale: string,
  opts: Intl.NumberFormatOptions,
): string {
  // Node 22's `Intl.NumberFormat.prototype.format` accepts a decimal string
  // directly (ECMA-402 ToIntlMathematicalValue) — no `Number()` conversion on
  // the money/quantity value itself (D6).
  return new Intl.NumberFormat(locale, opts).format(value as unknown as number);
}

export function registerInvoiceHelpers(hb: typeof Handlebars): void {
  hb.registerHelper(
    "money",
    (amount: unknown, options: Handlebars.HelperOptions) => {
      const root = rootOf(options);
      const negate = Boolean(options.hash?.negate);
      const str =
        typeof amount === "string" ? amount : String(amount ?? "0.00");
      if (negate && isZeroString(str)) return "–";
      const trimmed = str.trim();
      if (trimmed.startsWith("-")) {
        const abs = trimmed.slice(1);
        return `(${formatCurrency(abs, root.invoice.currency, root.locale)})`;
      }
      return formatCurrency(str, root.invoice.currency, root.locale);
    },
  );

  hb.registerHelper("date", (ymd: unknown) => {
    if (ymd === null || ymd === undefined || ymd === "") return "—";
    return formatCalendarDate(String(ymd));
  });

  hb.registerHelper("period", (a: unknown, b: unknown) => {
    const start =
      a === null || a === undefined ? "—" : formatCalendarDate(String(a));
    const end =
      b === null || b === undefined ? "—" : formatCalendarDate(String(b));
    return `${start} – ${end}`;
  });

  hb.registerHelper(
    "qty",
    (value: unknown, options: Handlebars.HelperOptions) => {
      if (value === null || value === undefined || value === "") return "—";
      const root = rootOf(options);
      return formatNumberString(String(value), root.locale, {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      });
    },
  );

  hb.registerHelper(
    "price",
    (value: unknown, options: Handlebars.HelperOptions) => {
      if (value === null || value === undefined || value === "") return "—";
      const root = rootOf(options);
      const str = String(value).trim();
      // 4 dp below 1 (sub-cent unit rates), else 2 dp — a string-based check
      // (no Number() on the value), matching integer-part-is-zero.
      const belowOne = /^-?0(\.\d+)?$/.test(str);
      const digits = belowOne ? 4 : 2;
      return formatNumberString(str, root.locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    },
  );

  hb.registerHelper(
    "int",
    (value: unknown, options: Handlebars.HelperOptions) => {
      if (value === null || value === undefined || value === "") return "—";
      const root = rootOf(options);
      return formatNumberString(String(value), root.locale, {
        maximumFractionDigits: 0,
      });
    },
  );

  hb.registerHelper(
    "amt",
    (value: unknown, options: Handlebars.HelperOptions) => {
      if (value === null || value === undefined || value === "") return "—";
      const root = rootOf(options);
      return formatNumberString(String(value), root.locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        useGrouping: false,
      });
    },
  );

  hb.registerHelper("unitCode", (unit: unknown) => {
    if (unit === null || unit === undefined) return "";
    const str = String(unit);
    return UNIT_CODE_MAP[str] ?? str;
  });

  // Reserved — never used by layout v1 (D6).
  hb.registerHelper("asset", () => {
    throw new InvoiceRenderError(
      "TEMPLATE_COMPILE_FAILED",
      "asset helper not available in v1",
    );
  });
}

import { describe, expect, it } from "vitest";

import {
  add,
  compare,
  isHeldLiability,
  MoneyPrecisionError,
  openReceivable,
  senToString,
  stringToSen,
  subtract,
  sum,
} from "@/services/accounts/money";

// ac07-spec §3.10 money.test.ts — add/subtract/compare/sum correctness,
// MONEY_PRECISION on >2dp, no float drift (code-standards §2.2).
describe("money.ts", () => {
  describe("add/subtract", () => {
    it("adds two decimal strings without float drift", () => {
      expect(add("0.10", "0.20")).toBe("0.30");
      expect(add("1234.56", "0.44")).toBe("1235.00");
      expect(add("100.00", "-30.00")).toBe("70.00");
    });

    it("subtracts two decimal strings without float drift", () => {
      expect(subtract("5400.00", "5400.00")).toBe("0.00");
      expect(subtract("0.30", "0.10")).toBe("0.20");
      expect(subtract("0.00", "-5400.00")).toBe("5400.00");
    });

    it("handles whole-number strings with no decimal point", () => {
      expect(add("100", "50")).toBe("150.00");
    });
  });

  describe("compare", () => {
    it("returns -1, 0, 1 correctly", () => {
      expect(compare("100.00", "200.00")).toBe(-1);
      expect(compare("200.00", "100.00")).toBe(1);
      expect(compare("100.00", "100.00")).toBe(0);
      expect(compare("100.00", "100")).toBe(0);
    });
  });

  describe("sum", () => {
    it("sums an arbitrary number of amounts", () => {
      expect(sum("100.00", "200.00", "0.50")).toBe("300.50");
    });

    it("returns 0.00 for an empty list", () => {
      expect(sum()).toBe("0.00");
    });
  });

  describe("MONEY_PRECISION", () => {
    it("throws MoneyPrecisionError on more than 2 decimal places", () => {
      expect(() => stringToSen("1.234")).toThrow(MoneyPrecisionError);
      expect(() => add("1.234", "1.00")).toThrow(MoneyPrecisionError);
      expect(() => compare("1.234", "1.00")).toThrow(MoneyPrecisionError);
    });

    it("carries the MONEY_PRECISION code on the thrown error", () => {
      try {
        stringToSen("1.234");
        expect.fail("expected stringToSen to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(MoneyPrecisionError);
        expect((error as MoneyPrecisionError).code).toBe("MONEY_PRECISION");
      }
    });
  });

  describe("senToString round-trip", () => {
    it("round-trips through stringToSen/senToString with no drift", () => {
      expect(senToString(stringToSen("999999999.99"))).toBe("999999999.99");
      expect(senToString(stringToSen("-42.05"))).toBe("-42.05");
      expect(senToString(stringToSen("0.00"))).toBe("0.00");
    });
  });

  describe("signed-balance helpers", () => {
    it("openReceivable returns the signed sen value", () => {
      expect(openReceivable("100.00")).toBe(100_00n);
      expect(openReceivable("0.00")).toBe(0n);
    });

    it("isHeldLiability is true only for a negative balance", () => {
      expect(isHeldLiability("-5400.00")).toBe(true);
      expect(isHeldLiability("0.00")).toBe(false);
      expect(isHeldLiability("100.00")).toBe(false);
    });
  });
});

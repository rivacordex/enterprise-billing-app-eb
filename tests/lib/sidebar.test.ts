import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIDEBAR_COLLAPSED,
  resolveSidebarCollapsed,
} from "@/lib/sidebar";

describe("resolveSidebarCollapsed (D9)", () => {
  it("defaults to collapsed when the cookie is absent", () => {
    expect(DEFAULT_SIDEBAR_COLLAPSED).toBe(true);
    expect(resolveSidebarCollapsed(undefined)).toBe(true);
  });

  it("expands on an explicit '0'", () => {
    expect(resolveSidebarCollapsed("0")).toBe(false);
  });

  it("collapses on an explicit '1'", () => {
    expect(resolveSidebarCollapsed("1")).toBe(true);
  });

  it("falls back to the default for an unexpected value", () => {
    expect(resolveSidebarCollapsed("yes")).toBe(true);
  });
});

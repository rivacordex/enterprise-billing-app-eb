import { describe, expect, it } from "vitest";

import { AUDIT_EVENT_TYPES } from "@/types/audit";
import {
  AUDIT_EVENT_CATEGORY_MAP,
  type AuditEventCategory,
} from "@/types/audit-log";

const VALID_CATEGORIES: AuditEventCategory[] = [
  "Additive",
  "Change",
  "Removal",
  "Session",
  "Security",
];

describe("AUDIT_EVENT_CATEGORY_MAP", () => {
  it("covers every AuditEventType with no gaps", () => {
    for (const eventType of AUDIT_EVENT_TYPES) {
      expect(AUDIT_EVENT_CATEGORY_MAP[eventType]).toBeDefined();
    }
  });

  it("maps every event type to exactly one of the five categories", () => {
    for (const eventType of AUDIT_EVENT_TYPES) {
      expect(VALID_CATEGORIES).toContain(AUDIT_EVENT_CATEGORY_MAP[eventType]);
    }
  });

  it("has no extra keys beyond the 20 known event types", () => {
    expect(Object.keys(AUDIT_EVENT_CATEGORY_MAP).sort()).toEqual(
      [...AUDIT_EVENT_TYPES].sort(),
    );
  });

  it("matches the documented category assignments per ui-context §3.7", () => {
    expect(AUDIT_EVENT_CATEGORY_MAP.USER_CREATED).toBe("Additive");
    expect(AUDIT_EVENT_CATEGORY_MAP.USER_ENABLED).toBe("Additive");
    expect(AUDIT_EVENT_CATEGORY_MAP.ROLE_CREATED).toBe("Additive");
    expect(AUDIT_EVENT_CATEGORY_MAP.ROLE_ASSIGNED).toBe("Additive");

    expect(AUDIT_EVENT_CATEGORY_MAP.USER_UPDATED).toBe("Change");
    expect(AUDIT_EVENT_CATEGORY_MAP.ROLE_UPDATED).toBe("Change");
    expect(AUDIT_EVENT_CATEGORY_MAP.PERMISSION_MAPPING_CHANGED).toBe("Change");
    expect(AUDIT_EVENT_CATEGORY_MAP.SYSTEM_CONFIG_CHANGED).toBe("Change");
    expect(AUDIT_EVENT_CATEGORY_MAP.USER_AUTH_METHOD_CHANGED).toBe("Change");

    expect(AUDIT_EVENT_CATEGORY_MAP.USER_DISABLED).toBe("Removal");
    expect(AUDIT_EVENT_CATEGORY_MAP.USER_DELETED).toBe("Removal");
    expect(AUDIT_EVENT_CATEGORY_MAP.ROLE_DELETED).toBe("Removal");
    expect(AUDIT_EVENT_CATEGORY_MAP.ROLE_REVOKED).toBe("Removal");

    expect(AUDIT_EVENT_CATEGORY_MAP.SSO_LOGIN).toBe("Session");
    expect(AUDIT_EVENT_CATEGORY_MAP.LOCAL_LOGIN).toBe("Session");
    expect(AUDIT_EVENT_CATEGORY_MAP.USER_FIRST_LOGIN).toBe("Session");

    expect(AUDIT_EVENT_CATEGORY_MAP.USER_LOCKED).toBe("Security");
    expect(AUDIT_EVENT_CATEGORY_MAP.USER_UNLOCKED).toBe("Security");
    expect(AUDIT_EVENT_CATEGORY_MAP.USER_PASSWORD_RESET).toBe("Security");
    expect(AUDIT_EVENT_CATEGORY_MAP.USER_PASSWORD_CHANGED).toBe("Security");
  });
});

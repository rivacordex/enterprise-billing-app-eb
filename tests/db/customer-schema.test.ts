import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";

import { organization, partyRole, contactMedium } from "@/db/schema/customer";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
  return Object.values(getTableColumns(table)).map((c) => c.name);
}

function nullableColumnNames(
  table: Parameters<typeof getTableColumns>[0],
): string[] {
  return Object.values(getTableColumns(table))
    .filter((c) => !c.notNull)
    .map((c) => c.name);
}

describe("customer.organization", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(organization).sort()).toEqual(
      [
        "organization_id",
        "name",
        "trading_name",
        "organization_type",
        "registration_number",
        "tax_id",
        "industry",
        "status",
        "status_reason",
        "last_modified_by",
        "created_datetime",
        "last_modified_datetime",
      ].sort(),
    );
  });

  it("has the documented nullable columns", () => {
    expect(nullableColumnNames(organization).sort()).toEqual(
      [
        "trading_name",
        "registration_number",
        "tax_id",
        "industry",
        "status_reason",
      ].sort(),
    );
  });
});

describe("customer.party_role", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(partyRole).sort()).toEqual(
      [
        "party_role_id",
        "engaged_party",
        "status",
        "status_reason",
        "party_role_specification",
        "account",
        "contact_medium",
        "last_modified_by",
        "created_datetime",
        "last_modified_datetime",
      ].sort(),
    );
  });

  it("has the documented nullable columns, including account with no FK/CHECK (Inv. #9)", () => {
    expect(nullableColumnNames(partyRole).sort()).toEqual(
      ["status_reason", "account", "contact_medium"].sort(),
    );
  });

  it("types party_role_specification as Record<string, unknown> (Inv. #7 — no shape schema)", () => {
    type Columns = ReturnType<typeof getTableColumns<typeof partyRole>>;
    type Inferred = Columns["partyRoleSpecification"]["_"]["data"];
    const value: Inferred = { anything: 1, goes: "here" };
    expect(value).toBeTruthy();
  });
});

describe("customer.contact_medium", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(contactMedium).sort()).toEqual(
      [
        "contact_medium_id",
        "ref_party_role",
        "contact_name",
        "contact_role",
        "phone_number",
        "email_address",
        "ga_address_line1",
        "ga_address_line2",
        "ga_city",
        "ga_state_province",
        "ga_postal_code",
        "ga_country",
        "preferred_contact_method",
        "last_modified_by",
        "created_datetime",
        "last_modified_datetime",
      ].sort(),
    );
  });

  it("has the documented nullable columns", () => {
    expect(nullableColumnNames(contactMedium).sort()).toEqual(
      [
        "contact_role",
        "phone_number",
        "email_address",
        "ga_address_line1",
        "ga_address_line2",
        "ga_city",
        "ga_state_province",
        "ga_postal_code",
        "ga_country",
        "preferred_contact_method",
      ].sort(),
    );
  });
});

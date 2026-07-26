import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import {
  billCycle,
  reasonCode,
  glAccount,
  glMapping,
} from "@/db/schema/billing/catalogs";
import { document, documentLine } from "@/db/schema/billing/documents";
import { ledgerBinding } from "@/db/schema/billing/ledger-binding";
import { accountingPeriod } from "@/db/schema/billing/periods";

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

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
}

function uniqueConstraintNames(
  table: Parameters<typeof getTableConfig>[0],
): (string | undefined)[] {
  return getTableConfig(table).uniqueConstraints.map((u) => u.name);
}

describe("billing.financial_account", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(financialAccount).sort()).toEqual(
      [
        "financial_account_id",
        "name",
        "description",
        "state",
        "ref_party_role_id",
        "contact",
        "currency",
        "credit_limit_amount",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has the documented nullable columns", () => {
    expect(nullableColumnNames(financialAccount).sort()).toEqual(
      ["description", "contact", "credit_limit_amount"].sort(),
    );
  });

  it("has no stored balance column (module Inv. #2, structural)", () => {
    expect(columnNames(financialAccount)).not.toContain("balance");
  });

  it("has the state CHECK", () => {
    expect(checkNames(financialAccount)).toEqual([
      "financial_account_state_check",
    ]);
  });
});

describe("billing.billing_account", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(billingAccount).sort()).toEqual(
      [
        "billing_account_id",
        "name",
        "description",
        "state",
        "ref_party_role_id",
        "contact",
        "ref_financial_account_id",
        "currency",
        "rating_type",
        "payment_status",
        "credit_limit_amount",
        "ref_bill_cycle_id",
        "payment_due_days_override",
        "default_payment_method_ref",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has the documented nullable columns", () => {
    expect(nullableColumnNames(billingAccount).sort()).toEqual(
      [
        "description",
        "contact",
        "credit_limit_amount",
        "payment_due_days_override",
        "default_payment_method_ref",
      ].sort(),
    );
  });

  it("has no stored balance column (module Inv. #2, structural)", () => {
    expect(columnNames(billingAccount)).not.toContain("balance");
  });

  it("has the state/rating_type/payment_status CHECKs", () => {
    expect(checkNames(billingAccount).sort()).toEqual(
      [
        "billing_account_state_check",
        "billing_account_rating_type_check",
        "billing_account_payment_status_check",
      ].sort(),
    );
  });
});

describe("billing.bill_cycle", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(billCycle).sort()).toEqual(
      [
        "bill_cycle_id",
        "name",
        "description",
        "frequency",
        "cycle_day",
        "payment_due_days",
        "state",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has the documented nullable columns, incl. last_edited_by (seed writes, Q13/Q14)", () => {
    expect(nullableColumnNames(billCycle).sort()).toEqual(
      ["description", "last_edited_by"].sort(),
    );
  });

  it("has the frequency/cycle_day/state CHECKs", () => {
    expect(checkNames(billCycle).sort()).toEqual(
      [
        "bill_cycle_frequency_check",
        "bill_cycle_cycle_day_check",
        "bill_cycle_state_check",
      ].sort(),
    );
  });
});

describe("billing.reason_code", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(reasonCode).sort()).toEqual(
      [
        "reason_code",
        "name",
        "description",
        "doc_type",
        "posting_nature",
        "auto_post_limit",
        "state",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has the documented nullable columns, incl. last_edited_by (seed writes)", () => {
    expect(nullableColumnNames(reasonCode).sort()).toEqual(
      ["description", "last_edited_by"].sort(),
    );
  });

  it("has the doc_type/posting_nature/state CHECKs", () => {
    expect(checkNames(reasonCode).sort()).toEqual(
      [
        "reason_code_doc_type_check",
        "reason_code_posting_nature_check",
        "reason_code_state_check",
      ].sort(),
    );
  });
});

describe("billing.gl_account", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(glAccount).sort()).toEqual(
      [
        "gl_code",
        "name",
        "account_class",
        "normal_balance",
        "parent_gl_code",
        "is_postable",
        "state",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has the documented nullable columns, incl. last_edited_by (seed writes)", () => {
    expect(nullableColumnNames(glAccount).sort()).toEqual(
      ["parent_gl_code", "last_edited_by"].sort(),
    );
  });

  it("has the account_class/normal_balance/state CHECKs", () => {
    expect(checkNames(glAccount).sort()).toEqual(
      [
        "gl_account_account_class_check",
        "gl_account_normal_balance_check",
        "gl_account_state_check",
      ].sort(),
    );
  });
});

describe("billing.gl_mapping", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(glMapping).sort()).toEqual(
      [
        "gl_mapping_id",
        "selector_type",
        "selector",
        "currency",
        "ref_gl_code",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has the documented nullable columns, incl. last_edited_by (seed writes)", () => {
    expect(nullableColumnNames(glMapping).sort()).toEqual(
      ["currency", "last_edited_by"].sort(),
    );
  });

  it("has the (selector_type, selector, currency) UNIQUE (Inv. #10)", () => {
    expect(uniqueConstraintNames(glMapping)).toEqual([
      "gl_mapping_selector_type_selector_currency_unique",
    ]);
  });

  it("has the selector_type CHECK", () => {
    expect(checkNames(glMapping)).toEqual(["gl_mapping_selector_type_check"]);
  });
});

describe("billing.document", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(document).sort()).toEqual(
      [
        "document_id",
        "doc_type",
        "state",
        "ref_financial_account_id",
        "ref_billing_account_id",
        "reason_code",
        "currency",
        "total_amount",
        "payment_mode",
        "mode_ref",
        "reference_date",
        "reference_info",
        "event_at",
        "posted_at",
        "reversal_of",
        "created_by",
        "approved_by",
        "metadata",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has the documented nullable columns", () => {
    expect(nullableColumnNames(document).sort()).toEqual(
      [
        "ref_billing_account_id",
        "payment_mode",
        "mode_ref",
        "posted_at",
        "reversal_of",
        "approved_by",
        "metadata",
      ].sort(),
    );
  });

  it("has no default on document_id (assembled in the insert repository, §2.2)", () => {
    expect(getTableColumns(document).documentId.hasDefault).toBe(false);
  });

  it("has the doc_type/state/payment_mode CHECKs", () => {
    expect(checkNames(document).sort()).toEqual(
      [
        "document_doc_type_check",
        "document_state_check",
        "document_payment_mode_check",
      ].sort(),
    );
  });
});

describe("billing.document_line", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(documentLine).sort()).toEqual(
      [
        "document_line_id",
        "ref_document_id",
        "line_no",
        "line_kind",
        "ref_billing_account_id",
        "ref_settled_document_id",
        "amount",
        "pgledger_transfer_id",
        "reversed_by_line_id",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has the documented nullable columns", () => {
    expect(nullableColumnNames(documentLine).sort()).toEqual(
      [
        "ref_billing_account_id",
        "ref_settled_document_id",
        "pgledger_transfer_id",
        "reversed_by_line_id",
      ].sort(),
    );
  });

  it("pgledger_transfer_id is UNIQUE nullable (module Inv. #7, §6.7)", () => {
    const column = getTableColumns(documentLine).pgledgerTransferId;
    expect(column.notNull).toBe(false);
    expect(column.isUnique).toBe(true);
  });

  it("has the (ref_document_id, line_no) UNIQUE", () => {
    expect(uniqueConstraintNames(documentLine)).toContain(
      "document_line_ref_document_id_line_no_unique",
    );
  });

  it("has the line_kind/amount CHECKs", () => {
    expect(checkNames(documentLine).sort()).toEqual(
      ["document_line_line_kind_check", "document_line_amount_check"].sort(),
    );
  });
});

describe("billing.ledger_binding", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(ledgerBinding).sort()).toEqual(
      [
        "ledger_binding_id",
        "owner_type",
        "owner_id",
        "ledger_role",
        "pgledger_account_id",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has no nullable columns beyond the base shape (every field required)", () => {
    expect(nullableColumnNames(ledgerBinding)).toEqual([]);
  });

  it("has the triple UNIQUE(owner_type, owner_id, ledger_role) (module Inv. #9)", () => {
    expect(uniqueConstraintNames(ledgerBinding)).toContain(
      "ledger_binding_owner_type_owner_id_ledger_role_unique",
    );
  });

  it("pgledger_account_id is UNIQUE", () => {
    expect(getTableColumns(ledgerBinding).pgledgerAccountId.isUnique).toBe(
      true,
    );
  });

  it("has the owner_type/ledger_role CHECKs", () => {
    expect(checkNames(ledgerBinding).sort()).toEqual(
      [
        "ledger_binding_owner_type_check",
        "ledger_binding_ledger_role_check",
      ].sort(),
    );
  });
});

describe("billing.accounting_period", () => {
  it("exposes the exact snake_case column set", () => {
    expect(columnNames(accountingPeriod).sort()).toEqual(
      [
        "period",
        "currency",
        "state",
        "closed_at",
        "closed_by",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has a composite primary key (period, currency) — Q12 multi-currency-ready", () => {
    const { primaryKeys } = getTableConfig(accountingPeriod);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]?.columns.map((c) => c.name).sort()).toEqual(
      ["period", "currency"].sort(),
    );
  });

  it("has the documented nullable columns, incl. last_edited_by (seed writes)", () => {
    expect(nullableColumnNames(accountingPeriod).sort()).toEqual(
      ["closed_at", "closed_by", "last_edited_by"].sort(),
    );
  });

  it("has the state CHECK", () => {
    expect(checkNames(accountingPeriod)).toEqual([
      "accounting_period_state_check",
    ]);
  });
});

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

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
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

  it("has no stored balance column (Module Inv. #2, structural)", () => {
    const columns = columnNames(financialAccount);
    expect(columns).not.toContain("balance");
    expect(columns).not.toContain("current_balance");
  });

  it("has the state CHECK constraint and name/ref_party_role_id/currency/last_edited_by NOT NULL", () => {
    expect(checkNames(financialAccount)).toEqual(
      expect.arrayContaining([
        "financial_account_state_check",
        "financial_account_credit_limit_amount_check",
      ]),
    );
    const columns = getTableColumns(financialAccount);
    expect(columns.name.notNull).toBe(true);
    expect(columns.refPartyRoleId.notNull).toBe(true);
    expect(columns.currency.notNull).toBe(true);
    expect(columns.lastEditedBy.notNull).toBe(true);
    expect(columns.description.notNull).toBe(false);
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

  it("has no stored balance column (Module Inv. #2, structural)", () => {
    const columns = columnNames(billingAccount);
    expect(columns).not.toContain("balance");
    expect(columns).not.toContain("current_balance");
  });

  it("has the state/rating_type/payment_status/credit_limit_amount CHECK constraints", () => {
    expect(checkNames(billingAccount)).toEqual(
      expect.arrayContaining([
        "billing_account_state_check",
        "billing_account_rating_type_check",
        "billing_account_payment_status_check",
        "billing_account_credit_limit_amount_check",
      ]),
    );
  });

  it("ref_financial_account_id and ref_bill_cycle_id are required (Q13/Q23)", () => {
    const columns = getTableColumns(billingAccount);
    expect(columns.refFinancialAccountId.notNull).toBe(true);
    expect(columns.refBillCycleId.notNull).toBe(true);
    expect(columns.paymentDueDaysOverride.notNull).toBe(false);
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

  it("has the frequency/cycle_day/state CHECK constraints", () => {
    expect(checkNames(billCycle)).toEqual(
      expect.arrayContaining([
        "bill_cycle_frequency_check",
        "bill_cycle_cycle_day_check",
        "bill_cycle_state_check",
      ]),
    );
  });

  it("last_edited_by is nullable (seed/infra writes have no acting user)", () => {
    expect(getTableColumns(billCycle).lastEditedBy.notNull).toBe(false);
  });
});

describe("billing.reason_code", () => {
  it("exposes the exact snake_case column set with a natural PK", () => {
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
    expect(getTableColumns(reasonCode).reasonCode.primary).toBe(true);
  });

  it("has the doc_type/posting_nature/state/auto_post_limit CHECK constraints", () => {
    expect(checkNames(reasonCode)).toEqual(
      expect.arrayContaining([
        "reason_code_doc_type_check",
        "reason_code_posting_nature_check",
        "reason_code_state_check",
        "reason_code_auto_post_limit_check",
      ]),
    );
  });
});

describe("billing.gl_account", () => {
  it("exposes the exact snake_case column set with a natural PK", () => {
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
    expect(getTableColumns(glAccount).glCode.primary).toBe(true);
  });

  it("has the account_class/normal_balance/state CHECK constraints", () => {
    expect(checkNames(glAccount)).toEqual(
      expect.arrayContaining([
        "gl_account_account_class_check",
        "gl_account_normal_balance_check",
        "gl_account_state_check",
      ]),
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
        "state",
        "last_modified",
        "last_edited_by",
      ].sort(),
    );
  });

  it("has the selector_type CHECK and the selector triple UNIQUE (Module Inv. #10)", () => {
    expect(checkNames(glMapping)).toContain("gl_mapping_selector_type_check");
    const { uniqueConstraints } = getTableConfig(glMapping);
    const triple = uniqueConstraints.find(
      (u) => u.name === "gl_mapping_selector_type_selector_currency_unique",
    );
    expect(triple?.columns.map((c) => c.name).sort()).toEqual(
      ["selector_type", "selector", "currency"].sort(),
    );
  });

  it("the selector triple UNIQUE is NULLS NOT DISTINCT (rejects a second all-currency mapping)", () => {
    const { uniqueConstraints } = getTableConfig(glMapping);
    const triple = uniqueConstraints.find(
      (u) => u.name === "gl_mapping_selector_type_selector_currency_unique",
    );
    expect(triple?.nullsNotDistinct).toBe(true);
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
        "entry_date",
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

  it("document_id has no column default (assembled in the insert repository, §2.2)", () => {
    expect(getTableColumns(document).documentId.hasDefault).toBe(false);
  });

  it("has the doc_type/state/payment_mode CHECK constraints", () => {
    expect(checkNames(document)).toEqual(
      expect.arrayContaining([
        "document_doc_type_check",
        "document_state_check",
        "document_payment_mode_check",
      ]),
    );
  });

  it("created_by/last_edited_by are required, approved_by/ref_billing_account_id are not (Q1/Q20)", () => {
    const columns = getTableColumns(document);
    expect(columns.createdBy.notNull).toBe(true);
    expect(columns.lastEditedBy.notNull).toBe(true);
    expect(columns.approvedBy.notNull).toBe(false);
    expect(columns.refBillingAccountId.notNull).toBe(false);
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

  it("pgledger_transfer_id is UNIQUE and nullable (Module Inv. #7)", () => {
    const column = getTableColumns(documentLine).pgledgerTransferId;
    expect(column.notNull).toBe(false);
    expect(column.isUnique).toBe(true);
  });

  it("has (ref_document_id, line_no) UNIQUE and the line_kind/amount CHECK constraints", () => {
    const { uniqueConstraints } = getTableConfig(documentLine);
    const pair = uniqueConstraints.find(
      (u) => u.name === "document_line_ref_document_id_line_no_unique",
    );
    expect(pair?.columns.map((c) => c.name).sort()).toEqual(
      ["ref_document_id", "line_no"].sort(),
    );
    expect(checkNames(documentLine)).toEqual(
      expect.arrayContaining([
        "document_line_line_kind_check",
        "document_line_amount_check",
      ]),
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

  it("has the (owner_type, owner_id, ledger_role) triple UNIQUE (Module Inv. #9)", () => {
    const { uniqueConstraints } = getTableConfig(ledgerBinding);
    const triple = uniqueConstraints.find(
      (u) => u.name === "ledger_binding_owner_type_owner_id_ledger_role_unique",
    );
    expect(triple?.columns.map((c) => c.name).sort()).toEqual(
      ["owner_type", "owner_id", "ledger_role"].sort(),
    );
  });

  it("pgledger_account_id is UNIQUE and NOT NULL", () => {
    const column = getTableColumns(ledgerBinding).pgledgerAccountId;
    expect(column.notNull).toBe(true);
    expect(column.isUnique).toBe(true);
  });

  it("has the owner_type/ledger_role CHECK constraints", () => {
    expect(checkNames(ledgerBinding)).toEqual(
      expect.arrayContaining([
        "ledger_binding_owner_type_check",
        "ledger_binding_ledger_role_check",
      ]),
    );
  });
});

describe("billing.accounting_period", () => {
  it("exposes the exact snake_case column set with a composite PK", () => {
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
    const { primaryKeys } = getTableConfig(accountingPeriod);
    expect(primaryKeys).toHaveLength(1);
    expect(primaryKeys[0]?.columns.map((c) => c.name).sort()).toEqual(
      ["period", "currency"].sort(),
    );
  });

  it("has the state and period-format CHECK constraints", () => {
    expect(checkNames(accountingPeriod)).toEqual(
      expect.arrayContaining([
        "accounting_period_state_check",
        "accounting_period_period_format_check",
      ]),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/update-organization.service.test.ts's mocking shape.
const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));

vi.mock("@/db/repositories/contact-medium", () => ({
  contactMediumRepository: {
    findByPartyRoleId: vi.fn(),
    findById: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    deleteById: vi.fn(),
    updatePreferredMethod: vi.fn(),
  },
}));
vi.mock("@/db/repositories/party-role", () => ({
  partyRoleRepository: {
    findById: vi.fn(),
    compareAndBumpLock: vi.fn(),
    setPreferredContact: vi.fn(),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));

import { contactMediumRepository } from "@/db/repositories/contact-medium";
import { partyRoleRepository } from "@/db/repositories/party-role";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import {
  addContact,
  deleteContact,
  resolveUpdatedPreferredMethod,
  setPreferredContact,
  setPreferredContactMethod,
  updateContact,
} from "@/services/customer/contact-mutations";
import type { AddContactInput } from "@/validation/customer/add-contact.schema";
import type { UpdateContactInput } from "@/validation/customer/update-contact.schema";
import type { DeleteContactInput } from "@/validation/customer/delete-contact.schema";
import type { SetPreferredContactInput } from "@/validation/customer/set-preferred-contact.schema";
import type { SetPreferredContactMethodInput } from "@/validation/customer/set-preferred-contact-method.schema";

const mockFindByPartyRoleId = vi.mocked(
  contactMediumRepository.findByPartyRoleId,
);
const mockInsert = vi.mocked(contactMediumRepository.insert);
const mockFindContactById = vi.mocked(contactMediumRepository.findById);
const mockUpdate = vi.mocked(contactMediumRepository.update);
const mockDeleteById = vi.mocked(contactMediumRepository.deleteById);
const mockUpdatePreferredMethod = vi.mocked(
  contactMediumRepository.updatePreferredMethod,
);
const mockFindById = vi.mocked(partyRoleRepository.findById);
const mockCompareAndBumpLock = vi.mocked(
  partyRoleRepository.compareAndBumpLock,
);
const mockSetPreferredContact = vi.mocked(
  partyRoleRepository.setPreferredContact,
);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

const SUBMITTED_LOCK = new Date("2026-01-01T00:00:00.000Z");
const BUMPED_LOCK = new Date("2026-01-01T00:00:01.000Z");

const BASE_INPUT: AddContactInput = {
  partyRoleId: "PTRL00000001",
  lastModifiedDatetime: SUBMITTED_LOCK,
  contactName: "Jane Doe",
  contactRole: null,
  phoneNumber: null,
  emailAddress: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  stateProvince: null,
  postalCode: null,
  country: null,
};

const SOME_PARTY_ROLE = { partyRoleId: "PTRL00000001" } as never;

const UPDATE_BASE_INPUT: UpdateContactInput = {
  contactMediumId: "CTMD00000001",
  partyRoleId: "PTRL00000001",
  lastModifiedDatetime: SUBMITTED_LOCK,
  contactName: "Jane Doe",
  contactRole: null,
  phoneNumber: null,
  emailAddress: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  stateProvince: null,
  postalCode: null,
  country: null,
};

const DELETE_BASE_INPUT: DeleteContactInput = {
  contactMediumId: "CTMD00000001",
  partyRoleId: "PTRL00000001",
  lastModifiedDatetime: SUBMITTED_LOCK,
};

const SET_PREFERRED_BASE_INPUT: SetPreferredContactInput = {
  contactMediumId: "CTMD00000002",
  partyRoleId: "PTRL00000001",
  lastModifiedDatetime: SUBMITTED_LOCK,
};

const SET_PREFERRED_METHOD_BASE_INPUT: SetPreferredContactMethodInput = {
  contactMediumId: "CTMD00000001",
  partyRoleId: "PTRL00000001",
  targetMethod: "EMAIL",
  lastModifiedDatetime: SUBMITTED_LOCK,
};

function buildInsertedContact(
  overrides: Partial<{
    contactMediumId: string;
    contactName: string;
    phoneNumber: string | null;
    emailAddress: string | null;
    preferredContactMethod: string | null;
  }>,
) {
  return {
    contactMediumId: "CTMD00000001",
    refPartyRole: "PTRL00000001",
    contactName: "Jane Doe",
    contactRole: null,
    phoneNumber: null,
    emailAddress: null,
    gaAddressLine1: null,
    gaAddressLine2: null,
    gaCity: null,
    gaStateProvince: null,
    gaPostalCode: null,
    gaCountry: null,
    preferredContactMethod: null,
    lastModifiedBy: "actor-1",
    createdDatetime: new Date(),
    lastModifiedDatetime: new Date(),
    ...overrides,
  } as never;
}

beforeEach(() => {
  mockFindByPartyRoleId.mockReset();
  mockInsert.mockReset();
  mockFindContactById.mockReset();
  mockUpdate.mockReset();
  mockDeleteById.mockReset();
  mockUpdatePreferredMethod.mockReset();
  mockFindById.mockReset();
  mockCompareAndBumpLock.mockReset();
  mockSetPreferredContact.mockReset();
  mockInsertAuditEvent.mockReset();

  mockFindById.mockResolvedValue(SOME_PARTY_ROLE);
  mockCompareAndBumpLock.mockResolvedValue(BUMPED_LOCK);
  mockInsert.mockResolvedValue(buildInsertedContact({}));
});

describe("addContact", () => {
  it("first contact for a party role with zero existing contacts sets the preferred-contact pointer and audits PREFERRED_CONTACT_CHANGED", async () => {
    mockFindByPartyRoleId.mockResolvedValue([]);

    const result = await addContact(BASE_INPUT, "actor-1");

    expect(mockSetPreferredContact).toHaveBeenCalledWith(
      txStub,
      "PTRL00000001",
      "CTMD00000001",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "CONTACT_CREATED",
        targetEntity: "CONTACT_MEDIUM",
        targetId: "CTMD00000001",
      }),
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "PREFERRED_CONTACT_CHANGED",
        targetEntity: "PARTY_ROLE",
        targetId: "PTRL00000001",
        beforeData: { preferredContactId: null },
        afterData: { preferredContactId: "CTMD00000001" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        contactMediumId: "CTMD00000001",
        lastModifiedDatetime: BUMPED_LOCK,
      },
    });
  });

  it("a second contact added to a party role that already has one leaves the pointer untouched and audits no PREFERRED_CONTACT_CHANGED event", async () => {
    mockFindByPartyRoleId.mockResolvedValue([
      buildInsertedContact({ contactMediumId: "CTMD00000001" }),
    ]);
    mockInsert.mockResolvedValue(
      buildInsertedContact({ contactMediumId: "CTMD00000002" }),
    );

    await addContact(BASE_INPUT, "actor-1");

    expect(mockSetPreferredContact).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({ eventType: "CONTACT_CREATED" }),
    );
  });

  it("stale lock returns CONFLICT with no contact row inserted and no pointer change", async () => {
    mockFindByPartyRoleId.mockResolvedValue([]);
    mockCompareAndBumpLock.mockResolvedValue(null);

    const result = await addContact(BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockSetPreferredContact).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("unknown partyRoleId returns PARTY_ROLE_NOT_FOUND before any lock check", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await addContact(BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "PARTY_ROLE_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
  });

  it.each([
    [{ phoneNumber: "555-1000" }, "PHONE"],
    [{ phoneNumber: "555-1000", emailAddress: "j@example.com" }, "PHONE"],
    [{ emailAddress: "j@example.com" }, "EMAIL"],
    [{ emailAddress: "j@example.com", addressLine1: "1 Main St" }, "EMAIL"],
    [{ addressLine1: "1 Main St" }, "ADDRESS"],
    [{}, null],
  ] as const)(
    "resolves preferred method %j -> %s",
    async (overrides, expected) => {
      mockFindByPartyRoleId.mockResolvedValue([]);

      await addContact({ ...BASE_INPUT, ...overrides }, "actor-1");

      expect(mockInsert).toHaveBeenCalledWith(
        txStub,
        expect.objectContaining({ preferredContactMethod: expected }),
      );
    },
  );
});

describe("resolveUpdatedPreferredMethod", () => {
  it.each([
    [null, {}, { ok: true, value: null }],
    [null, { phoneNumber: "555-1000" }, { ok: true, value: "PHONE" }],
    [null, { emailAddress: "j@example.com" }, { ok: true, value: "EMAIL" }],
    [null, { addressLine1: "1 Main St" }, { ok: true, value: "ADDRESS" }],
    ["PHONE", { phoneNumber: "555-1000" }, { ok: true, value: "PHONE" }], // still populated after the edit — untouched
    [
      "PHONE",
      { phoneNumber: null, emailAddress: "j@example.com" },
      { ok: false },
    ], // cleared while another remains populated — blocked (Module Inv. #5)
    ["PHONE", { phoneNumber: null }, { ok: true, value: null }], // cleared to zero populated — allowed
    ["EMAIL", { emailAddress: null, addressLine1: "1 Main St" }, { ok: false }],
    ["ADDRESS", { addressLine1: null }, { ok: true, value: null }],
  ] as const)(
    "current=%s, updated overrides=%j -> %j",
    (current, overrides, expected) => {
      const updated = { ...UPDATE_BASE_INPUT, ...overrides };
      expect(resolveUpdatedPreferredMethod(current, updated)).toEqual(expected);
    },
  );
});

describe("updateContact", () => {
  it("unknown contactMediumId returns CONTACT_NOT_FOUND before any lock check", async () => {
    mockFindContactById.mockResolvedValue(null);

    const result = await updateContact(UPDATE_BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "CONTACT_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
  });

  it("clearing the preferred method's field while another remains populated is blocked before any transaction opens", async () => {
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({ preferredContactMethod: "PHONE" }),
    );

    const result = await updateContact(
      {
        ...UPDATE_BASE_INPUT,
        phoneNumber: null,
        emailAddress: "j@example.com",
      },
      "actor-1",
    );

    expect(result).toEqual({
      ok: false,
      code: "PREFERRED_METHOD_STILL_POPULATED",
    });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("clearing the preferred method's field down to zero populated methods succeeds, preferredContactMethod becomes null", async () => {
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({
        preferredContactMethod: "PHONE",
        phoneNumber: "555-1000",
      }),
    );
    mockUpdate.mockResolvedValue(
      buildInsertedContact({ preferredContactMethod: null, phoneNumber: null }),
    );

    const result = await updateContact(
      { ...UPDATE_BASE_INPUT, phoneNumber: null },
      "actor-1",
    );

    expect(mockUpdate).toHaveBeenCalledWith(
      txStub,
      "CTMD00000001",
      expect.objectContaining({ preferredContactMethod: null }),
    );
    expect(result).toEqual({
      ok: true,
      value: { lastModifiedDatetime: BUMPED_LOCK },
    });
  });

  it("an edit that never touches the preferred field leaves it unchanged, no reassignment logic triggered", async () => {
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({
        preferredContactMethod: "EMAIL",
        emailAddress: "j@example.com",
      }),
    );
    mockUpdate.mockResolvedValue(
      buildInsertedContact({
        preferredContactMethod: "EMAIL",
        emailAddress: "j@example.com",
      }),
    );

    await updateContact(
      {
        ...UPDATE_BASE_INPUT,
        emailAddress: "j@example.com",
        contactName: "Jane Updated",
      },
      "actor-1",
    );

    expect(mockUpdate).toHaveBeenCalledWith(
      txStub,
      "CTMD00000001",
      expect.objectContaining({
        preferredContactMethod: "EMAIL",
        contactName: "Jane Updated",
      }),
    );
  });

  it("stale lock returns CONFLICT with no update or audit", async () => {
    mockFindContactById.mockResolvedValue(buildInsertedContact({}));
    mockCompareAndBumpLock.mockResolvedValue(null);

    const result = await updateContact(UPDATE_BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("a contact belonging to a different party role returns CONTACT_NOT_FOUND before any lock check", async () => {
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({ refPartyRole: "PTRL00000099" } as never),
    );

    const result = await updateContact(UPDATE_BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "CONTACT_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("a successful update audits CONTACT_UPDATED with before/after data", async () => {
    const before = buildInsertedContact({ preferredContactMethod: null });
    mockFindContactById.mockResolvedValue(before);
    const after = buildInsertedContact({
      contactName: "Jane Updated",
      preferredContactMethod: null,
    });
    mockUpdate.mockResolvedValue(after);

    await updateContact(
      { ...UPDATE_BASE_INPUT, contactName: "Jane Updated" },
      "actor-1",
    );

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "CONTACT_UPDATED",
        targetEntity: "CONTACT_MEDIUM",
        targetId: "CTMD00000001",
        beforeData: before,
        afterData: after,
      }),
    );
  });
});

describe("deleteContact", () => {
  it("unknown contactMediumId returns CONTACT_NOT_FOUND before any lock check", async () => {
    mockFindContactById.mockResolvedValue(null);

    const result = await deleteContact(DELETE_BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "CONTACT_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
    expect(mockDeleteById).not.toHaveBeenCalled();
  });

  it("a contact belonging to a different party role returns CONTACT_NOT_FOUND, no lock bump, update, or audit", async () => {
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({
        contactMediumId: "CTMD00000001",
        refPartyRole: "PTRL00000099",
      } as never),
    );

    const result = await deleteContact(DELETE_BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "CONTACT_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
    expect(mockDeleteById).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("deleting the currently-preferred contact is blocked, no transaction opened, row still present", async () => {
    const contact = buildInsertedContact({ contactMediumId: "CTMD00000001" });
    mockFindContactById.mockResolvedValue(contact);
    mockFindById.mockResolvedValue({
      partyRoleId: "PTRL00000001",
      contactMedium: "CTMD00000001",
    } as never);

    const result = await deleteContact(DELETE_BASE_INPUT, "actor-1");

    expect(result).toEqual({
      ok: false,
      code: "CANNOT_DELETE_PREFERRED_CONTACT",
    });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
    expect(mockDeleteById).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("stale lock returns CONFLICT with the row still present", async () => {
    const contact = buildInsertedContact({ contactMediumId: "CTMD00000001" });
    mockFindContactById.mockResolvedValue(contact);
    mockFindById.mockResolvedValue({
      partyRoleId: "PTRL00000001",
      contactMedium: "CTMD00000002", // preferred is a different contact
    } as never);
    mockCompareAndBumpLock.mockResolvedValue(null);

    const result = await deleteContact(DELETE_BASE_INPUT, "actor-1");

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockDeleteById).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("deleting a non-preferred contact succeeds, deletes the row, and audits CONTACT_DELETED with the full pre-delete row as beforeData and afterData: null", async () => {
    const contact = buildInsertedContact({ contactMediumId: "CTMD00000001" });
    mockFindContactById.mockResolvedValue(contact);
    mockFindById.mockResolvedValue({
      partyRoleId: "PTRL00000001",
      contactMedium: "CTMD00000002", // preferred is a different contact
    } as never);

    const result = await deleteContact(DELETE_BASE_INPUT, "actor-1");

    expect(mockDeleteById).toHaveBeenCalledWith(txStub, "CTMD00000001");
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "CONTACT_DELETED",
        targetEntity: "CONTACT_MEDIUM",
        targetId: "CTMD00000001",
        beforeData: contact,
        afterData: null,
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: { lastModifiedDatetime: BUMPED_LOCK },
    });
  });

  it("a party role with no preferred contact set (contactMedium null) allows deleting any of its contacts", async () => {
    const contact = buildInsertedContact({ contactMediumId: "CTMD00000001" });
    mockFindContactById.mockResolvedValue(contact);
    mockFindById.mockResolvedValue({
      partyRoleId: "PTRL00000001",
      contactMedium: null,
    } as never);

    const result = await deleteContact(DELETE_BASE_INPUT, "actor-1");

    expect(result.ok).toBe(true);
    expect(mockDeleteById).toHaveBeenCalledWith(txStub, "CTMD00000001");
  });
});

describe("setPreferredContact", () => {
  it("reassigning among two existing contacts moves the pointer and audits before/after data", async () => {
    mockFindById.mockResolvedValue({
      partyRoleId: "PTRL00000001",
      contactMedium: "CTMD00000001",
    } as never);
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({ contactMediumId: "CTMD00000002" }),
    );

    const result = await setPreferredContact(
      SET_PREFERRED_BASE_INPUT,
      "actor-1",
    );

    expect(mockSetPreferredContact).toHaveBeenCalledWith(
      txStub,
      "PTRL00000001",
      "CTMD00000002",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "PREFERRED_CONTACT_CHANGED",
        targetEntity: "PARTY_ROLE",
        targetId: "PTRL00000001",
        beforeData: { preferredContactId: "CTMD00000001" },
        afterData: { preferredContactId: "CTMD00000002" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: { lastModifiedDatetime: BUMPED_LOCK },
    });
  });

  it("unknown partyRoleId returns PARTY_ROLE_NOT_FOUND before any lock check", async () => {
    mockFindById.mockResolvedValue(null);

    const result = await setPreferredContact(
      SET_PREFERRED_BASE_INPUT,
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "PARTY_ROLE_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
  });

  it("reassigning to a contact belonging to a different party role returns CONTACT_NOT_FOUND, no write", async () => {
    mockFindById.mockResolvedValue({
      partyRoleId: "PTRL00000001",
      contactMedium: "CTMD00000001",
    } as never);
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({
        contactMediumId: "CTMD00000002",
        refPartyRole: "PTRL00000099",
      } as never),
    );

    const result = await setPreferredContact(
      SET_PREFERRED_BASE_INPUT,
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONTACT_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
    expect(mockSetPreferredContact).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("unknown contactMediumId returns CONTACT_NOT_FOUND before any lock check", async () => {
    mockFindById.mockResolvedValue({
      partyRoleId: "PTRL00000001",
      contactMedium: "CTMD00000001",
    } as never);
    mockFindContactById.mockResolvedValue(null);

    const result = await setPreferredContact(
      SET_PREFERRED_BASE_INPUT,
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONTACT_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
  });

  it("reassigning to the already-preferred contact still succeeds as a no-op-value write, bump and audit still happen", async () => {
    mockFindById.mockResolvedValue({
      partyRoleId: "PTRL00000001",
      contactMedium: "CTMD00000002",
    } as never);
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({ contactMediumId: "CTMD00000002" }),
    );

    const result = await setPreferredContact(
      SET_PREFERRED_BASE_INPUT,
      "actor-1",
    );

    expect(mockSetPreferredContact).toHaveBeenCalledWith(
      txStub,
      "PTRL00000001",
      "CTMD00000002",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "PREFERRED_CONTACT_CHANGED",
        beforeData: { preferredContactId: "CTMD00000002" },
        afterData: { preferredContactId: "CTMD00000002" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: { lastModifiedDatetime: BUMPED_LOCK },
    });
  });

  it("stale lock returns CONFLICT with no pointer change or audit", async () => {
    mockFindById.mockResolvedValue({
      partyRoleId: "PTRL00000001",
      contactMedium: "CTMD00000001",
    } as never);
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({ contactMediumId: "CTMD00000002" }),
    );
    mockCompareAndBumpLock.mockResolvedValue(null);

    const result = await setPreferredContact(
      SET_PREFERRED_BASE_INPUT,
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockSetPreferredContact).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});

describe("setPreferredContactMethod", () => {
  it("switching between two populated methods succeeds and audits PREFERRED_METHOD_CHANGED", async () => {
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({
        phoneNumber: "555-1000",
        emailAddress: "j@example.com",
        preferredContactMethod: "PHONE",
      }),
    );

    const result = await setPreferredContactMethod(
      SET_PREFERRED_METHOD_BASE_INPUT,
      "actor-1",
    );

    expect(mockUpdatePreferredMethod).toHaveBeenCalledWith(
      txStub,
      "CTMD00000001",
      "EMAIL",
      "actor-1",
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "PREFERRED_METHOD_CHANGED",
        targetEntity: "CONTACT_MEDIUM",
        targetId: "CTMD00000001",
        beforeData: { preferredContactMethod: "PHONE" },
        afterData: { preferredContactMethod: "EMAIL" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: { lastModifiedDatetime: BUMPED_LOCK },
    });
  });

  it("targeting an unpopulated method returns METHOD_NOT_POPULATED before any transaction opens", async () => {
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({
        phoneNumber: "555-1000",
        emailAddress: null,
        preferredContactMethod: "PHONE",
      }),
    );

    const result = await setPreferredContactMethod(
      SET_PREFERRED_METHOD_BASE_INPUT,
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "METHOD_NOT_POPULATED" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
    expect(mockUpdatePreferredMethod).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("unknown contactMediumId returns CONTACT_NOT_FOUND before any lock check", async () => {
    mockFindContactById.mockResolvedValue(null);

    const result = await setPreferredContactMethod(
      SET_PREFERRED_METHOD_BASE_INPUT,
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONTACT_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
  });

  it("targeting a contact belonging to a different party role returns CONTACT_NOT_FOUND, no write", async () => {
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({
        emailAddress: "j@example.com",
        refPartyRole: "PTRL00000099",
      } as never),
    );

    const result = await setPreferredContactMethod(
      SET_PREFERRED_METHOD_BASE_INPUT,
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONTACT_NOT_FOUND" });
    expect(mockCompareAndBumpLock).not.toHaveBeenCalled();
    expect(mockUpdatePreferredMethod).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("stale lock returns CONFLICT with no update or audit", async () => {
    mockFindContactById.mockResolvedValue(
      buildInsertedContact({ emailAddress: "j@example.com" }),
    );
    mockCompareAndBumpLock.mockResolvedValue(null);

    const result = await setPreferredContactMethod(
      SET_PREFERRED_METHOD_BASE_INPUT,
      "actor-1",
    );

    expect(result).toEqual({ ok: false, code: "CONFLICT" });
    expect(mockUpdatePreferredMethod).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});

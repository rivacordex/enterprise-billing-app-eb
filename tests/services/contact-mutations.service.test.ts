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
    insert: vi.fn(),
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
import { addContact } from "@/services/customer/contact-mutations";
import type { AddContactInput } from "@/validation/customer/add-contact.schema";

const mockFindByPartyRoleId = vi.mocked(
  contactMediumRepository.findByPartyRoleId,
);
const mockInsert = vi.mocked(contactMediumRepository.insert);
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

function buildInsertedContact(
  overrides: Partial<{
    contactMediumId: string;
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

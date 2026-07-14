import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors tests/services/get-offering-detail.service.test.ts: mock
// @/db/client so importing the service never triggers lib/config's eager
// env validation.
vi.mock("@/db/client", () => ({ db: {} }));

vi.mock("@/db/repositories/party-role", () => ({
  partyRoleRepository: { findById: vi.fn() },
}));
vi.mock("@/db/repositories/organization", () => ({
  organizationRepository: { findById: vi.fn() },
}));
vi.mock("@/db/repositories/contact-medium", () => ({
  contactMediumRepository: { findByPartyRoleId: vi.fn() },
}));
vi.mock("@/db/repositories/appuser.repository", () => ({
  findUserById: vi.fn(),
}));

import { findUserById } from "@/db/repositories/appuser.repository";
import { contactMediumRepository } from "@/db/repositories/contact-medium";
import { organizationRepository } from "@/db/repositories/organization";
import { partyRoleRepository } from "@/db/repositories/party-role";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";

const mockFindPartyRoleById = vi.mocked(partyRoleRepository.findById);
const mockFindOrganizationById = vi.mocked(organizationRepository.findById);
const mockFindContacts = vi.mocked(contactMediumRepository.findByPartyRoleId);
const mockFindUserById = vi.mocked(findUserById);

const ORGANIZATION = {
  organizationId: "ORG0000001",
  name: "Acme Corp",
  tradingName: null,
  organizationType: "COMPANY" as const,
  registrationNumber: null,
  taxId: null,
  industry: null,
  status: "ACTIVE" as const,
  statusReason: null,
  lastModifiedBy: "user-org-editor",
  lastModifiedDatetime: new Date("2026-01-01T00:00:00Z"),
  createdDatetime: new Date("2026-01-01T00:00:00Z"),
};

const PARTY_ROLE = {
  partyRoleId: "PTRL00000001",
  engagedParty: "ORG0000001",
  status: "ACTIVE" as const,
  statusReason: null,
  partyRoleSpecification: {},
  account: null,
  contactMedium: "CTMD00000001",
  lastModifiedBy: "user-role-editor",
  lastModifiedDatetime: new Date("2026-02-01T00:00:00Z"),
  createdDatetime: new Date("2026-02-01T00:00:00Z"),
};

beforeEach(() => {
  mockFindPartyRoleById.mockReset();
  mockFindOrganizationById.mockReset();
  mockFindContacts.mockReset();
  mockFindUserById.mockReset();
});

describe("getCustomerDetail", () => {
  it("returns null for an unknown partyRoleId and calls no other finder", async () => {
    mockFindPartyRoleById.mockResolvedValue(null);

    const result = await getCustomerDetail("PTRL99999999");

    expect(result).toBeNull();
    expect(mockFindOrganizationById).not.toHaveBeenCalled();
    expect(mockFindContacts).not.toHaveBeenCalled();
    expect(mockFindUserById).not.toHaveBeenCalled();
  });

  it("fails closed (null) when the organization row is missing", async () => {
    mockFindPartyRoleById.mockResolvedValue(PARTY_ROLE as never);
    mockFindOrganizationById.mockResolvedValue(null);

    const result = await getCustomerDetail("PTRL00000001");

    expect(result).toBeNull();
    expect(mockFindContacts).not.toHaveBeenCalled();
  });

  it("wires isPreferredContact against partyRole.contactMedium", async () => {
    mockFindPartyRoleById.mockResolvedValue(PARTY_ROLE as never);
    mockFindOrganizationById.mockResolvedValue(ORGANIZATION as never);
    mockFindContacts.mockResolvedValue([
      {
        contactMediumId: "CTMD00000001",
        refPartyRole: "PTRL00000001",
        contactName: "Preferred Contact",
        contactRole: null,
        phoneNumber: "123",
        emailAddress: null,
        gaAddressLine1: null,
        gaAddressLine2: null,
        gaCity: null,
        gaStateProvince: null,
        gaPostalCode: null,
        gaCountry: null,
        preferredContactMethod: "PHONE",
        lastModifiedBy: "user-role-editor",
        lastModifiedDatetime: new Date(),
        createdDatetime: new Date(),
      },
      {
        contactMediumId: "CTMD00000002",
        refPartyRole: "PTRL00000001",
        contactName: "Other Contact",
        contactRole: null,
        phoneNumber: null,
        emailAddress: "other@example.com",
        gaAddressLine1: null,
        gaAddressLine2: null,
        gaCity: null,
        gaStateProvince: null,
        gaPostalCode: null,
        gaCountry: null,
        preferredContactMethod: null,
        lastModifiedBy: "user-role-editor",
        lastModifiedDatetime: new Date(),
        createdDatetime: new Date(),
      },
    ] as never);
    mockFindUserById.mockResolvedValue({ userName: "Editor" } as never);

    const result = await getCustomerDetail("PTRL00000001");

    expect(result?.contacts[0]).toMatchObject({
      contactMediumId: "CTMD00000001",
      isPreferredContact: true,
    });
    expect(result?.contacts[1]).toMatchObject({
      contactMediumId: "CTMD00000002",
      isPreferredContact: false,
    });
  });

  it("address is null when ga_address_line1 is null", async () => {
    mockFindPartyRoleById.mockResolvedValue(PARTY_ROLE as never);
    mockFindOrganizationById.mockResolvedValue(ORGANIZATION as never);
    mockFindContacts.mockResolvedValue([
      {
        contactMediumId: "CTMD00000001",
        refPartyRole: "PTRL00000001",
        contactName: "No Address",
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
        lastModifiedBy: "user-role-editor",
        lastModifiedDatetime: new Date(),
        createdDatetime: new Date(),
      },
    ] as never);
    mockFindUserById.mockResolvedValue({ userName: "Editor" } as never);

    const result = await getCustomerDetail("PTRL00000001");

    expect(result?.contacts[0]?.address).toBeNull();
  });

  it("address is a full ContactAddress when ga_address_line1 is populated", async () => {
    mockFindPartyRoleById.mockResolvedValue(PARTY_ROLE as never);
    mockFindOrganizationById.mockResolvedValue(ORGANIZATION as never);
    mockFindContacts.mockResolvedValue([
      {
        contactMediumId: "CTMD00000001",
        refPartyRole: "PTRL00000001",
        contactName: "Has Address",
        contactRole: null,
        phoneNumber: null,
        emailAddress: null,
        gaAddressLine1: "1 Main St",
        gaAddressLine2: "Suite 2",
        gaCity: "Kuala Lumpur",
        gaStateProvince: "WP",
        gaPostalCode: "50000",
        gaCountry: "Malaysia",
        preferredContactMethod: "ADDRESS",
        lastModifiedBy: "user-role-editor",
        lastModifiedDatetime: new Date(),
        createdDatetime: new Date(),
      },
    ] as never);
    mockFindUserById.mockResolvedValue({ userName: "Editor" } as never);

    const result = await getCustomerDetail("PTRL00000001");

    expect(result?.contacts[0]?.address).toEqual({
      line1: "1 Main St",
      line2: "Suite 2",
      city: "Kuala Lumpur",
      stateProvince: "WP",
      postalCode: "50000",
      country: "Malaysia",
    });
  });

  it("assembles organization + customerRole sections with resolved editor names", async () => {
    mockFindPartyRoleById.mockResolvedValue(PARTY_ROLE as never);
    mockFindOrganizationById.mockResolvedValue(ORGANIZATION as never);
    mockFindContacts.mockResolvedValue([]);
    mockFindUserById.mockImplementation(async (_db, userId: string) => {
      if (userId === "user-org-editor") {
        return { userName: "Org Editor" } as never;
      }
      return { userName: "Role Editor" } as never;
    });

    const result = await getCustomerDetail("PTRL00000001");

    expect(result?.organization.lastModifiedByName).toBe("Org Editor");
    expect(result?.customerRole.lastModifiedByName).toBe("Role Editor");
    expect(result?.customerRole.preferredContactId).toBe("CTMD00000001");
    expect(result?.contacts).toEqual([]);
  });
});

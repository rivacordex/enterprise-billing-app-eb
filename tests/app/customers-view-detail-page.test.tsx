import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level + full render — unlike the search page's mocked-child
// precedent, this page's own children (OrganizationSection etc.) are plain
// synchronous Server Components with no DB/service imports of their own, so
// they render safely under vitest without mocking (cm05-spec §3.8).
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/customer/get-customer-detail", () => ({
  getCustomerDetail: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
}));

import CustomerDetailPage from "@/app/(app)/customers/view/[id]/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
import type { CustomerDetail } from "@/types/customer";

const mockRequirePermission = vi.mocked(requirePermission);
const mockGetCustomerDetail = vi.mocked(getCustomerDetail);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

const FIXTURE: CustomerDetail = {
  organization: {
    organizationId: "ORG00000001",
    name: "Acme Utilities",
    tradingName: "Acme",
    organizationType: "COMPANY",
    registrationNumber: "REG12345",
    taxId: "TAX99999",
    industry: "Utilities",
    status: "ACTIVE",
    statusReason: null,
    lastModifiedByName: "Jordan Rivera",
    lastModifiedDatetime: new Date("2026-07-01T10:00:00.000Z"),
  },
  customerRole: {
    partyRoleId: "PTRL00000001",
    status: "ACTIVE",
    statusReason: null,
    specification: { tier: "gold" },
    account: null,
    preferredContactId: null,
    lastModifiedByName: "Jordan Rivera",
    lastModifiedDatetime: new Date("2026-07-01T10:00:00.000Z"),
  },
  contacts: [],
};

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockGetCustomerDetail.mockReset();
  mockRequirePermission.mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: null,
      customers: "READ",
    },
  });
});

describe("CustomerDetailPage", () => {
  it("calls requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.READ) as the first statement", async () => {
    mockGetCustomerDetail.mockResolvedValue(null);

    await CustomerDetailPage({
      params: Promise.resolve({ id: "PTRL00000001" }),
    });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.CUSTOMERS,
      LEVELS.READ,
    );
  });

  it("propagates the /no-access redirect for a user without customers:READ and never calls getCustomerDetail", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(
      CustomerDetailPage({ params: Promise.resolve({ id: "PTRL00000001" }) }),
    ).rejects.toThrow();
    expect(mockGetCustomerDetail).not.toHaveBeenCalled();
  });

  it("a malformed ID short-circuits: getCustomerDetail is not called, 'Customer not found' renders", async () => {
    const result = await CustomerDetailPage({
      params: Promise.resolve({ id: "not-a-real-id" }),
    });
    render(result);

    expect(mockGetCustomerDetail).not.toHaveBeenCalled();
    expect(screen.getByText("Customer not found")).toBeInTheDocument();
  });

  it("a well-formed but unknown ID: getCustomerDetail is called, then 'Customer not found' renders", async () => {
    mockGetCustomerDetail.mockResolvedValue(null);

    const result = await CustomerDetailPage({
      params: Promise.resolve({ id: "PTRL99999999" }),
    });
    render(result);

    expect(mockGetCustomerDetail).toHaveBeenCalledWith("PTRL99999999");
    expect(screen.getByText("Customer not found")).toBeInTheDocument();
  });

  it("happy path: renders all three section titles and the organization name in the h1", async () => {
    mockGetCustomerDetail.mockResolvedValue(FIXTURE);

    const result = await CustomerDetailPage({
      params: Promise.resolve({ id: "PTRL00000001" }),
    });
    render(result);

    expect(
      screen.getByRole("heading", { level: 1, name: "Acme Utilities" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Party – Organization")).toBeInTheDocument();
    expect(screen.getByText("Role – Customer")).toBeInTheDocument();
    expect(screen.getByText("Customer – Contact Details")).toBeInTheDocument();
  });

  it("the inconsistency banner does not render for an ordinary status pairing", async () => {
    mockGetCustomerDetail.mockResolvedValue(FIXTURE);

    const result = await CustomerDetailPage({
      params: Promise.resolve({ id: "PTRL00000001" }),
    });
    render(result);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("the inconsistency banner renders for a genuinely conflicting status pairing", async () => {
    mockGetCustomerDetail.mockResolvedValue({
      ...FIXTURE,
      organization: { ...FIXTURE.organization, status: "SUSPENDED" },
    });

    const result = await CustomerDetailPage({
      params: Promise.resolve({ id: "PTRL00000001" }),
    });
    render(result);

    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

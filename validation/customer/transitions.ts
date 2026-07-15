import type { CustomerStatus, OrganizationStatus } from "@/types/customer";

export const ORGANIZATION_TRANSITIONS: Record<
  OrganizationStatus,
  readonly OrganizationStatus[]
> = {
  REGISTERED: ["ACTIVE", "DISSOLVED"],
  ACTIVE: ["INACTIVE", "SUSPENDED", "DISSOLVED", "MERGED"],
  INACTIVE: ["ACTIVE", "SUSPENDED", "DISSOLVED", "MERGED"],
  SUSPENDED: ["ACTIVE", "INACTIVE", "DISSOLVED", "MERGED"],
  DISSOLVED: [],
  MERGED: [],
} as const;

// No skipping VALIDATED (INITIALIZED can only reach VALIDATED or CLOSED,
// never ACTIVE directly); any non-terminal state can reach CLOSED
// (cm02-spec §3.2). This is the one place either transition map is
// declared — no later unit re-declares a status's next-states.
export const CUSTOMER_TRANSITIONS: Record<
  CustomerStatus,
  readonly CustomerStatus[]
> = {
  INITIALIZED: ["VALIDATED", "CLOSED"],
  VALIDATED: ["ACTIVE", "CLOSED"],
  ACTIVE: ["SUSPENDED", "CLOSED"],
  SUSPENDED: ["ACTIVE", "CLOSED"],
  CLOSED: [],
} as const;

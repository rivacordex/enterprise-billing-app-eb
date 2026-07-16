export const ORGANIZATION_STATUSES = [
  "REGISTERED",
  "ACTIVE",
  "INACTIVE",
  "SUSPENDED",
  "DISSOLVED",
  "MERGED",
] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const CUSTOMER_STATUSES = [
  "INITIALIZED",
  "VALIDATED",
  "ACTIVE",
  "SUSPENDED",
  "CLOSED",
] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const ORGANIZATION_TYPES = ["COMPANY", "GOVERNMENT"] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export const PREFERRED_CONTACT_METHODS = ["PHONE", "EMAIL", "ADDRESS"] as const;
export type PreferredContactMethod = (typeof PREFERRED_CONTACT_METHODS)[number];

export type {
  Organization,
  OrganizationInsert,
  PartyRole,
  PartyRoleInsert,
  ContactMedium,
  ContactMediumInsert,
} from "@/db/schema";

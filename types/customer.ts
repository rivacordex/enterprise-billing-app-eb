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

export interface OrganizationDetail {
  organizationId: string;
  name: string;
  tradingName: string | null;
  organizationType: OrganizationType;
  registrationNumber: string | null;
  taxId: string | null;
  industry: string | null;
  status: OrganizationStatus;
  statusReason: string | null;
  lastModifiedByName: string;
  lastModifiedDatetime: Date;
}

export interface CustomerRoleDetail {
  partyRoleId: string;
  status: CustomerStatus;
  statusReason: string | null;
  specification: Record<string, unknown>;
  account: string | null;
  preferredContactId: string | null;
  lastModifiedByName: string;
  lastModifiedDatetime: Date; // the value cm08's edit page round-trips for the optimistic-lock check
}

export interface ContactAddress {
  line1: string;
  line2: string | null;
  city: string | null;
  stateProvince: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface ContactRow {
  contactMediumId: string;
  contactName: string;
  contactRole: string | null;
  phoneNumber: string | null;
  emailAddress: string | null;
  address: ContactAddress | null; // null iff ga_address_line1 IS NULL (cm02-spec §2.2.9)
  preferredMethod: PreferredContactMethod | null;
  isPreferredContact: boolean;
}

export interface CustomerDetail {
  organization: OrganizationDetail;
  customerRole: CustomerRoleDetail;
  contacts: ContactRow[];
}

export interface CustomerSearchResult {
  partyRoleId: string;
  organizationId: string;
  organizationName: string;
  tradingName: string | null;
  organizationStatus: OrganizationStatus;
  customerStatus: CustomerStatus;
}

export interface CustomerSearchResults {
  results: CustomerSearchResult[];
  hasMore: boolean;
  limit: number;
  query: string;
}

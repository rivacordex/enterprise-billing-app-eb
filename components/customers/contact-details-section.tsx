import { Mail, MapPin, Phone } from "lucide-react";

import { PreferredIndicator } from "@/components/customers/preferred-indicator";
import type { ContactAddress, ContactRow } from "@/types/customer";

export interface ContactDetailsSectionProps {
  contacts: ContactRow[];
}

function formatAddress(address: ContactAddress): React.JSX.Element {
  const cityLine = [address.city, address.stateProvince, address.postalCode]
    .filter((part) => part !== null && part !== "")
    .join(" ");

  return (
    <span className="block">
      <span className="block">{address.line1}</span>
      {address.line2 && <span className="block">{address.line2}</span>}
      {cityLine && <span className="block">{cityLine}</span>}
      {address.country && <span className="block">{address.country}</span>}
    </span>
  );
}

function ContactCard({ contact }: { contact: ContactRow }): React.JSX.Element {
  const hasAnyMethod =
    contact.phoneNumber !== null ||
    contact.emailAddress !== null ||
    contact.address !== null;

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">
          {contact.contactName}
          {contact.contactRole && (
            <span className="text-muted-foreground">
              {" "}
              · {contact.contactRole}
            </span>
          )}
        </span>
        {hasAnyMethod && contact.isPreferredContact && (
          <PreferredIndicator label="Preferred contact" />
        )}
      </div>

      {!hasAnyMethod ? (
        <p className="mt-2 text-body-sm text-muted-foreground">
          No contact method on file
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          {contact.phoneNumber && (
            <div className="flex items-center gap-1.5 text-body-sm text-[color:var(--color-neutral-600)]">
              <Phone size={14} aria-hidden="true" />
              <span>{contact.phoneNumber}</span>
              {contact.preferredMethod === "PHONE" && (
                <PreferredIndicator label="Preferred method" />
              )}
            </div>
          )}
          {contact.emailAddress && (
            <div className="flex items-center gap-1.5 text-body-sm text-[color:var(--color-neutral-600)]">
              <Mail size={14} aria-hidden="true" />
              <span>{contact.emailAddress}</span>
              {contact.preferredMethod === "EMAIL" && (
                <PreferredIndicator label="Preferred method" />
              )}
            </div>
          )}
          {contact.address && (
            <div className="flex items-start gap-1.5 text-body-sm text-[color:var(--color-neutral-600)]">
              <MapPin
                size={14}
                className="mt-0.5 shrink-0"
                aria-hidden="true"
              />
              {formatAddress(contact.address)}
              {contact.preferredMethod === "ADDRESS" && (
                <PreferredIndicator label="Preferred method" />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ContactDetailsSection({
  contacts,
}: ContactDetailsSectionProps): React.JSX.Element {
  return (
    <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-4">
      <h2 className="text-h3 font-semibold text-foreground">
        Customer – Contact Details
      </h2>

      {contacts.length === 0 ? (
        <p className="mt-4 text-body text-muted-foreground">
          No contacts on file
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {contacts.map((contact) => (
            <ContactCard key={contact.contactMediumId} contact={contact} />
          ))}
        </div>
      )}
    </section>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, MapPin, Phone } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import type { z } from "zod";

import { addContactAction } from "@/actions/customer/add-contact";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { OptimisticLockConflictBanner } from "@/components/customers/optimistic-lock-conflict-banner";
import { PreferredIndicator } from "@/components/customers/preferred-indicator";
import type { ContactAddress, ContactRow } from "@/types/customer";
import { contactFieldsSchema } from "@/validation/customer/contact-medium.schema";

type ContactFormValues = z.input<typeof contactFieldsSchema>;
type ContactFormOutput = z.output<typeof contactFieldsSchema>;

const EMPTY_DEFAULTS: ContactFormValues = {
  contactName: "",
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

// Converts a blank text input to `null` before Zod validation runs — same
// convention as OrganizationForm's `emptyToNull`.
function emptyToNull(value: string): string | null {
  return value === "" ? null : value;
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

// Composes the same per-contact visual pattern `cm05`'s
// `ContactDetailsSection` established (name + role, phone/email/address rows
// with icons, `PreferredIndicator` at the contact level and per-method) —
// not forked, since View's version is read-only JSX with no controls and
// Manage's needs edit/delete affordances `cm12`/`cm13` will add later.
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
        {contact.isPreferredContact && (
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
                <PreferredIndicator label="Preferred phone" />
              )}
            </div>
          )}
          {contact.emailAddress && (
            <div className="flex items-center gap-1.5 text-body-sm text-[color:var(--color-neutral-600)]">
              <Mail size={14} aria-hidden="true" />
              <span>{contact.emailAddress}</span>
              {contact.preferredMethod === "EMAIL" && (
                <PreferredIndicator label="Preferred email" />
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
                <PreferredIndicator label="Preferred address" />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface ContactManagerPanelProps {
  partyRoleId: string;
  contacts: ContactRow[];
  lastModifiedDatetime: Date;
}

export function ContactManagerPanel({
  partyRoleId,
  contacts,
  lastModifiedDatetime,
}: ContactManagerPanelProps): React.JSX.Element {
  const router = useRouter();
  const [showAddForm, setShowAddForm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [currentLastModifiedDatetime, setCurrentLastModifiedDatetime] =
    useState(lastModifiedDatetime);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ContactFormValues, unknown, ContactFormOutput>({
    resolver: zodResolver(contactFieldsSchema),
    defaultValues: EMPTY_DEFAULTS,
  });

  function handleCancel(): void {
    reset(EMPTY_DEFAULTS);
    setShowAddForm(false);
  }

  async function onSubmit(values: ContactFormOutput): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await addContactAction({
        ...values,
        partyRoleId,
        lastModifiedDatetime: currentLastModifiedDatetime,
      });

      if (result.ok) {
        setCurrentLastModifiedDatetime(result.value.lastModifiedDatetime);
        reset(EMPTY_DEFAULTS);
        setShowAddForm(false);
        toast.success("Contact added.");
        router.refresh();
        return;
      }

      if (result.code === "CONFLICT") {
        setConflict(true);
        return;
      }

      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="space-y-4 rounded-md border border-border bg-[color:var(--surface-card)] p-4">
      <h2 className="text-h3 font-semibold text-foreground">
        Customer – Contact Details
      </h2>

      {contacts.length === 0 ? (
        <p className="text-body text-muted-foreground">No contacts on file</p>
      ) : (
        <div className="flex flex-col gap-3">
          {contacts.map((contact) => (
            <ContactCard key={contact.contactMediumId} contact={contact} />
          ))}
        </div>
      )}

      {conflict ? (
        <OptimisticLockConflictBanner onReload={() => router.refresh()} />
      ) : showAddForm ? (
        <form
          noValidate
          onSubmit={(e) => void handleSubmit(onSubmit)(e)}
          className="max-w-xl space-y-6 rounded-md border border-border p-4"
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="contactName">Name</FieldLabel>
              <Input
                id="contactName"
                type="text"
                autoComplete="off"
                aria-invalid={!!errors.contactName}
                disabled={isSubmitting}
                {...register("contactName")}
              />
              <FieldError errors={[errors.contactName]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="contactRole">Role</FieldLabel>
              <Input
                id="contactRole"
                type="text"
                autoComplete="off"
                aria-invalid={!!errors.contactRole}
                disabled={isSubmitting}
                {...register("contactRole", { setValueAs: emptyToNull })}
              />
              <FieldError errors={[errors.contactRole]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="phoneNumber">Phone</FieldLabel>
              <Input
                id="phoneNumber"
                type="text"
                autoComplete="off"
                aria-invalid={!!errors.phoneNumber}
                disabled={isSubmitting}
                {...register("phoneNumber", { setValueAs: emptyToNull })}
              />
              <FieldError errors={[errors.phoneNumber]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="emailAddress">Email</FieldLabel>
              <Input
                id="emailAddress"
                type="text"
                autoComplete="off"
                aria-invalid={!!errors.emailAddress}
                disabled={isSubmitting}
                {...register("emailAddress", { setValueAs: emptyToNull })}
              />
              <FieldError errors={[errors.emailAddress]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="addressLine1">Address Line 1</FieldLabel>
              <Input
                id="addressLine1"
                type="text"
                autoComplete="off"
                aria-invalid={!!errors.addressLine1}
                disabled={isSubmitting}
                {...register("addressLine1", { setValueAs: emptyToNull })}
              />
              <FieldError errors={[errors.addressLine1]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="addressLine2">Address Line 2</FieldLabel>
              <Input
                id="addressLine2"
                type="text"
                autoComplete="off"
                aria-invalid={!!errors.addressLine2}
                disabled={isSubmitting}
                {...register("addressLine2", { setValueAs: emptyToNull })}
              />
              <FieldError errors={[errors.addressLine2]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="city">City</FieldLabel>
              <Input
                id="city"
                type="text"
                autoComplete="off"
                aria-invalid={!!errors.city}
                disabled={isSubmitting}
                {...register("city", { setValueAs: emptyToNull })}
              />
              <FieldError errors={[errors.city]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="stateProvince">State / Province</FieldLabel>
              <Input
                id="stateProvince"
                type="text"
                autoComplete="off"
                aria-invalid={!!errors.stateProvince}
                disabled={isSubmitting}
                {...register("stateProvince", { setValueAs: emptyToNull })}
              />
              <FieldError errors={[errors.stateProvince]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="postalCode">Postal Code</FieldLabel>
              <Input
                id="postalCode"
                type="text"
                autoComplete="off"
                aria-invalid={!!errors.postalCode}
                disabled={isSubmitting}
                {...register("postalCode", { setValueAs: emptyToNull })}
              />
              <FieldError errors={[errors.postalCode]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="country">Country</FieldLabel>
              <Input
                id="country"
                type="text"
                autoComplete="off"
                aria-invalid={!!errors.country}
                disabled={isSubmitting}
                {...register("country", { setValueAs: emptyToNull })}
              />
              <FieldError errors={[errors.country]} />
            </Field>
          </FieldGroup>

          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={isSubmitting}
              className="bg-[color:var(--action-cta-bg)] text-white hover:bg-[color:var(--action-cta-bg)]/90"
            >
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={handleCancel}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          onClick={() => setShowAddForm(true)}
          className="bg-[color:var(--action-cta-bg)] text-white hover:bg-[color:var(--action-cta-bg)]/90"
        >
          Add contact
        </Button>
      )}
    </section>
  );
}

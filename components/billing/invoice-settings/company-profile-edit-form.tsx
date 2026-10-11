"use client";

// bm59-spec §Design D3, ui-context §10b — the company profile form's EDIT mode
// for `invoice_settings : EDIT` users. React Hook Form with the shared draft
// schema (`invoiceProfileDraftSchema`, after the same normalisation the server
// applies), so the form rejects exactly what the action rejects: formats are
// checked on save, completeness only at activation (bm61). **Save draft**
// writes the single working DRAFT version; it is never used on invoices.
// Country is fixed to `MY` this phase. The logo is never sent with the form:
// bm60's `LogoUploadField` uploads it onto the stored draft on its own.
// bm61: **Activate v{n}** (the Deep Petrol page action, ui-context §7) opens
// `ActivateVersionDialog` with the field diff against the ACTIVE version and,
// when payment fields change, the bank warning; every check is the server's.

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Controller,
  useForm,
  useWatch,
  type FieldErrors,
  type Resolver,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import {
  activateProfileAction,
  type ActivateProfileActionResult,
} from "@/actions/billing/invoice-settings/activate-profile.action";
import { saveProfileDraftAction } from "@/actions/billing/invoice-settings/save-profile-draft.action";
import {
  ActivateVersionDialog,
  type ActivateConfirmResult,
} from "@/components/billing/invoice-settings/activate-version-dialog";
import { DRAFT_CONFLICT_MESSAGE } from "@/components/billing/invoice-settings/draft-messages";
import { ColourSwatch } from "@/components/billing/invoice-settings/colour-swatch";
import { LogoUploadField } from "@/components/billing/invoice-settings/logo-upload-field";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MIN_TEXT_CONTRAST, whiteTextContrast } from "@/lib/colour-contrast";
import {
  describeProfileChanges,
  paymentFieldsChanged,
} from "@/lib/invoice-profile-changes";
import { COUNTRY_LABELS, MYINVOIS_STATE_LABELS } from "@/lib/myinvois-states";
import { cn } from "@/lib/utils";
import {
  INVOICE_PROFILE_FIELD_LABELS,
  type InvoiceProfileView,
} from "@/types/billing";
import {
  INVOICE_PROFILE_FIELD_KEYS,
  invoiceProfileDraftSchema,
  normalizeInvoiceProfileDraftInput,
  type InvoiceProfileDraftInput,
  type InvoiceProfileFieldKey,
} from "@/validation/billing/invoice-profile.schema";

type ProfileFormValues = Record<InvoiceProfileFieldKey, string>;

const FIXED_COUNTRY = "MY";
const SAVE_FAILED_MESSAGE = "The draft could not be saved. Please try again.";

// bm61 D5 — the bank-change Warning callout, verbatim from the spec.
// #11 (owner decision 2026-10-11) — a save whose values match the stored draft
// once trimmed and normalised writes nothing.
export const NO_CHANGES_MESSAGE = "No changes — nothing was saved.";

export const BANK_CHANGE_WARNING =
  "Bank details change on every new invoice. Customers will be asked to pay into the new account from the next bill run.";

const ACTIVATE_MESSAGES: Record<
  Extract<ActivateProfileActionResult, { ok: false }>["code"],
  string
> = {
  CHANGE_NOTE_REQUIRED: "A change note is required.",
  DRAFT_CONFLICT: DRAFT_CONFLICT_MESSAGE,
  PROFILE_LOGO_REQUIRED: "Upload a logo before activating the profile.",
  ASSET_CHECKSUM_MISMATCH:
    "The stored logo failed verification. Upload the logo again. Nothing was activated.",
  VALIDATION_ERROR:
    "The profile is incomplete or invalid. Complete the marked fields, save the draft, then activate.",
  FORBIDDEN: "You do not have permission to activate the profile.",
  SERVER_ERROR: "The profile could not be activated. Please try again.",
};

// The "Create a draft" action on the empty state focuses this field.
export const PROFILE_FIRST_FIELD_ID = "profile-company_name";

const STATE_CODES = Object.keys(MYINVOIS_STATE_LABELS).sort((a, b) =>
  a.localeCompare(b),
);
const FIELD_KEY_SET: ReadonlySet<string> = new Set(INVOICE_PROFILE_FIELD_KEYS);

// D2 — the form validates what the server validates: the same normalisation
// (trim, blank → absent, upper-casing, account-no. spaces, terms → int), then
// the same draft schema. The submitted values stay the raw strings; the
// action normalises and re-parses them.
const draftResolver = zodResolver(invoiceProfileDraftSchema);
const resolver: Resolver<ProfileFormValues> = async (
  values,
  context,
  options,
) => {
  const result = await draftResolver(
    normalizeInvoiceProfileDraftInput(values) as InvoiceProfileDraftInput,
    context,
    options as unknown as Parameters<typeof draftResolver>[2],
  );
  if (Object.keys(result.errors).length > 0) {
    return {
      values: {},
      errors: result.errors as FieldErrors<ProfileFormValues>,
    };
  }
  return { values, errors: {} };
};

function initialValues(fields: InvoiceProfileView): ProfileFormValues {
  const values = {} as ProfileFormValues;
  for (const key of INVOICE_PROFILE_FIELD_KEYS) values[key] = fields[key] ?? "";
  values.country_code = FIXED_COUNTRY;
  return values;
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-4 rounded-none border border-border bg-card p-4">
      <h3 className="text-h3 font-semibold text-foreground">{title}</h3>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export interface CompanyProfileEditFormProps {
  fields: InvoiceProfileView;
  // The session-guarded logo URL, or `null` when the version has no logo.
  logoSrc: string | null;
  expectedDraftToken: string | null;
  // bm60 D8 — offer "Use the current app logo" (no logo asset exists yet).
  showLogoImport?: boolean;
  // bm61 — the working draft's version (Activate shows only when set) and the
  // ACTIVE field map the dialog diffs against.
  draftVersion?: number | null;
  activeFields?: InvoiceProfileView | null;
}

export function CompanyProfileEditForm({
  fields,
  logoSrc,
  expectedDraftToken,
  showLogoImport = false,
  draftVersion = null,
  activeFields = null,
}: CompanyProfileEditFormProps): React.JSX.Element {
  const router = useRouter();
  const [draftToken, setDraftToken] = useState(expectedDraftToken);
  const [activateOpen, setActivateOpen] = useState(false);
  // bm61 D5 — `PROFILE_LOGO_REQUIRED` also shows inline by the logo field.
  const [logoError, setLogoError] = useState<string | null>(null);
  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<ProfileFormValues>({
    resolver,
    defaultValues: initialValues(fields),
  });

  async function onSubmit(values: ProfileFormValues): Promise<void> {
    try {
      const result = await saveProfileDraftAction({
        fields: values,
        expectedDraftToken: draftToken,
      });
      if (result.ok) {
        setDraftToken(result.draftToken);
        setLogoError(null);
        reset(values);
        if (result.changed) {
          toast.success(
            `Draft profile v${result.versionNo} saved — not used on invoices`,
          );
        } else {
          toast.info(NO_CHANGES_MESSAGE);
        }
        return;
      }
      if (result.code === "DRAFT_CONFLICT") {
        toast.warning(DRAFT_CONFLICT_MESSAGE, {
          action: { label: "Reload", onClick: () => router.refresh() },
        });
      } else if (result.code === "VALIDATION_ERROR") {
        let unmapped = false;
        for (const [key, messages] of Object.entries(result.fieldErrors)) {
          if (FIELD_KEY_SET.has(key)) {
            setError(key as InvoiceProfileFieldKey, {
              type: "server",
              message: messages[0] ?? "Invalid value",
            });
          } else {
            unmapped = true;
          }
        }
        if (unmapped || Object.keys(result.fieldErrors).length === 0) {
          toast.error("The profile was not valid. Reload and try again.");
        }
      } else if (result.code === "FORBIDDEN") {
        toast.error("You do not have permission to save the draft.");
      } else {
        toast.error(SAVE_FAILED_MESSAGE);
      }
    } catch {
      toast.error(SAVE_FAILED_MESSAGE);
    }
  }

  // bm61 — activate the saved draft. The diff and warning describe the saved
  // draft (`fields`); Activate is only enabled with no unsaved edits.
  const changes = describeProfileChanges(activeFields, fields);
  const bankChanged = paymentFieldsChanged(activeFields, fields);

  async function activate(changeNote: string): Promise<ActivateConfirmResult> {
    setLogoError(null);
    if (draftVersion === null || draftToken === null) {
      return { ok: false, message: DRAFT_CONFLICT_MESSAGE };
    }
    const result = await activateProfileAction({
      configVersion: draftVersion,
      expectedDraftToken: draftToken,
      changeNote,
    });
    if (result.ok) {
      // The action revalidated the layout; the page re-renders on the new
      // ACTIVE version and remounts this form.
      toast.success(`Company profile v${result.configVersion} activated`);
      return { ok: true };
    }
    if (result.code === "DRAFT_CONFLICT") {
      toast.warning(DRAFT_CONFLICT_MESSAGE, {
        action: { label: "Reload", onClick: () => router.refresh() },
      });
    } else if (result.code === "PROFILE_LOGO_REQUIRED") {
      setLogoError(ACTIVATE_MESSAGES.PROFILE_LOGO_REQUIRED);
    } else if (result.code === "VALIDATION_ERROR") {
      for (const [key, messages] of Object.entries(result.fieldErrors)) {
        if (FIELD_KEY_SET.has(key)) {
          setError(key as InvoiceProfileFieldKey, {
            type: "server",
            message: messages[0] ?? "Required",
          });
        }
      }
    }
    return { ok: false, message: ACTIVATE_MESSAGES[result.code] };
  }

  function textField(
    key: InvoiceProfileFieldKey,
    options: {
      mono?: boolean;
      optional?: boolean;
      hint?: string;
      type?: "text" | "email" | "url" | "tel";
      inputMode?: "numeric";
    } = {},
  ): React.JSX.Element {
    const id = `profile-${key}`;
    const error = errors[key];
    const hintId = options.hint ? `${id}-hint` : undefined;
    return (
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={id}>
          {INVOICE_PROFILE_FIELD_LABELS[key]}
          {options.optional ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              (optional)
            </span>
          ) : null}
        </FieldLabel>
        <Input
          id={id}
          type={options.type ?? "text"}
          inputMode={options.inputMode}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={hintId}
          className={cn(options.mono && "font-mono text-mono")}
          {...register(key)}
        />
        {options.hint ? (
          <FieldDescription id={hintId}>{options.hint}</FieldDescription>
        ) : null}
        <FieldError errors={[error]} />
      </Field>
    );
  }

  return (
    <form
      noValidate
      aria-label="Company profile"
      onSubmit={handleSubmit(onSubmit)}
      className="space-y-4"
    >
      <Group title="Company">
        {textField("company_name")}
        {textField("registration_no", { mono: true })}
        {textField("tin", { mono: true })}
        {textField("sst_reg_no", {
          mono: true,
          optional: true,
          hint: "Hidden on the invoice when blank",
        })}
        {textField("address_line1")}
        {textField("address_line2", { optional: true })}
        {textField("postcode", { mono: true, inputMode: "numeric" })}
        {textField("city")}
        <Field data-invalid={errors.state_code ? true : undefined}>
          <FieldLabel htmlFor="profile-state_code">
            {INVOICE_PROFILE_FIELD_LABELS.state_code}
          </FieldLabel>
          <Controller
            control={control}
            name="state_code"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger
                  id="profile-state_code"
                  className="w-full"
                  aria-invalid={errors.state_code ? true : undefined}
                  onBlur={field.onBlur}
                >
                  <SelectValue placeholder="Choose a state" />
                </SelectTrigger>
                <SelectContent>
                  {STATE_CODES.map((code) => (
                    <SelectItem key={code} value={code}>
                      <span className="font-mono text-mono">{code}</span>{" "}
                      {MYINVOIS_STATE_LABELS[code]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldError errors={[errors.state_code]} />
        </Field>
        <Field>
          <FieldLabel htmlFor="profile-country_code">
            {INVOICE_PROFILE_FIELD_LABELS.country_code}
          </FieldLabel>
          <p id="profile-country_code" className="text-body text-foreground">
            {COUNTRY_LABELS[FIXED_COUNTRY]}{" "}
            <span className="font-mono text-mono text-muted-foreground">
              ({FIXED_COUNTRY})
            </span>
          </p>
        </Field>
        {textField("phone", { type: "tel" })}
        {textField("email", { type: "email" })}
        {textField("website", { type: "url", optional: true })}
      </Group>

      <Group title="Payment">
        {textField("bank_name")}
        {textField("bank_account_name")}
        {textField("bank_account_no", { mono: true })}
        {textField("swift", { mono: true })}
        {textField("jompay_biller_code", {
          mono: true,
          optional: true,
          inputMode: "numeric",
        })}
        {textField("remittance_email", { type: "email" })}
      </Group>

      <Group title="Branding">
        <ColourInput
          name="brand_color"
          control={control}
          register={register}
          error={errors.brand_color?.message}
        />
        <ColourInput
          name="accent_color"
          control={control}
          register={register}
          error={errors.accent_color?.message}
        />
        <Field>
          <FieldLabel>
            {INVOICE_PROFILE_FIELD_LABELS.logo_asset_version_id}
          </FieldLabel>
          {/* bm60 — the upload writes to the stored draft and re-renders the
              page on the new token, so unsaved edits would be lost: the field
              waits until they are saved. */}
          <LogoUploadField
            logoSrc={logoSrc}
            draftToken={draftToken}
            blockedReason={isDirty ? "Save your changes first." : null}
            showImport={showLogoImport}
            externalError={logoError}
          />
        </Field>
      </Group>

      <Group title="Defaults">
        {textField("payment_terms_days", { mono: true, inputMode: "numeric" })}
      </Group>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="submit"
          variant="outline"
          disabled={!isDirty || isSubmitting}
        >
          {isSubmitting ? "Saving…" : "Save draft"}
        </Button>
        {draftVersion !== null ? (
          <button
            type="button"
            disabled={isDirty || isSubmitting}
            title={isDirty ? "Save the draft before activating" : undefined}
            onClick={() => setActivateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--billrun-cta-bg)] px-4 py-2 text-body-sm font-semibold text-[color:var(--billrun-cta-text)] hover:bg-[color:var(--billrun-cta-bg-hover)] focus:outline-none focus-visible:[box-shadow:var(--focus-ring)] active:bg-[color:var(--billrun-cta-bg-active)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDirty ? "Save draft first" : `Activate v${draftVersion}`}
          </button>
        ) : null}
      </div>

      {draftVersion !== null ? (
        <ActivateVersionDialog
          open={activateOpen}
          onOpenChange={setActivateOpen}
          title={`Activate company profile v${draftVersion}`}
          confirmLabel={`Activate v${draftVersion}`}
          summary={
            changes.length === 0 ? (
              <p>No change from the active profile.</p>
            ) : (
              <ul className="space-y-1" aria-label="Changes">
                {changes.map((c) => (
                  <li key={c.key}>
                    <span className="font-semibold">{c.label}:</span>{" "}
                    <span className="font-mono text-mono">{c.from ?? "—"}</span>{" "}
                    → <span className="font-mono text-mono">{c.to ?? "—"}</span>
                  </li>
                ))}
              </ul>
            )
          }
          warning={bankChanged ? BANK_CHANGE_WARNING : undefined}
          onConfirm={activate}
        />
      ) : null}
    </form>
  );
}

// ui-context §10b — mono `#RRGGBB` input, a 20×20 swatch, and a non-blocking
// Warning hint when white text on the colour is below 4.5:1.
function ColourInput({
  name,
  control,
  register,
  error,
}: {
  name: "brand_color" | "accent_color";
  control: ReturnType<typeof useForm<ProfileFormValues>>["control"];
  register: ReturnType<typeof useForm<ProfileFormValues>>["register"];
  error: string | undefined;
}): React.JSX.Element {
  const value = useWatch({ control, name }).trim();
  const contrast = whiteTextContrast(value);
  const id = `profile-${name}`;
  const hintId = `${id}-contrast`;
  const lowContrast = contrast !== null && contrast < MIN_TEXT_CONTRAST;
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{INVOICE_PROFILE_FIELD_LABELS[name]}</FieldLabel>
      <div className="flex items-center gap-2">
        <ColourSwatch value={value} />
        <Input
          id={id}
          autoComplete="off"
          placeholder="#RRGGBB"
          aria-invalid={error ? true : undefined}
          aria-describedby={lowContrast ? hintId : undefined}
          className="font-mono text-mono"
          {...register(name)}
        />
      </div>
      {lowContrast ? (
        <p
          id={hintId}
          role="status"
          className="inline-flex items-center gap-1.5 text-body-sm text-[color:var(--color-warning-700)]"
        >
          <TriangleAlert size={14} aria-hidden />
          White text on this colour is {contrast.toFixed(1)}:1, below{" "}
          {MIN_TEXT_CONTRAST}:1 — it may be hard to read.
        </p>
      ) : null}
      <FieldError errors={error ? [{ message: error }] : []} />
    </Field>
  );
}

// bm59 D3 — the empty state's "Create a draft" action: focuses the form.
export function CreateDraftButton(): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => document.getElementById(PROFILE_FIRST_FIELD_ID)?.focus()}
    >
      Create a draft
    </Button>
  );
}

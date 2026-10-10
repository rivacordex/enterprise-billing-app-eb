// bm56-spec §Tests: the read-mode company profile form renders plain text (no
// inputs), colour swatches, the logo <img> pointing at the session-guarded GET
// route, and "—" for blank optional fields. The history table's profile kind
// is covered here too (no Layout column, no Default chip, numeric View link).
// bm59-spec §Tests: EDIT mode — client-side rejection mirrors the server
// (same messages from the same schema), the contrast hint, live swatches, the
// SST hint, Save draft (pristine-disabled, token, toast, conflict + Reload,
// server field errors) and the empty state's "Create a draft" focus.
// bm61-spec §Tests: Activate — shown only on the working draft, "Save draft
// first" while dirty; the dialog lists `label: old → new`; the bank warning
// appears only when payment fields differ; the server's message is shown
// (and PROFILE_LOGO_REQUIRED also inline by the logo field).

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/billing/invoice-settings/save-profile-draft.action", () => ({
  saveProfileDraftAction: vi.fn(),
}));
vi.mock("@/actions/billing/invoice-settings/activate-profile.action", () => ({
  activateProfileAction: vi.fn(),
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

import { activateProfileAction } from "@/actions/billing/invoice-settings/activate-profile.action";
import { saveProfileDraftAction } from "@/actions/billing/invoice-settings/save-profile-draft.action";
import {
  BANK_CHANGE_WARNING,
  CreateDraftButton,
  NO_CHANGES_MESSAGE,
  PROFILE_FIRST_FIELD_ID,
} from "@/components/billing/invoice-settings/company-profile-edit-form";
import { CompanyProfileForm } from "@/components/billing/invoice-settings/company-profile-form";
import { saveProfileDraftInputSchema } from "@/validation/billing/invoice-profile.schema";
import { VersionHistoryTable } from "@/components/billing/invoice-settings/version-history-table";
import type { ProfileHistoryRow } from "@/types/billing";

const FIELDS = {
  company_name: "Digital Billing Sdn Bhd",
  registration_no: "202001000001",
  tin: "C1234567890",
  sst_reg_no: null,
  address_line1: "Level 5, Menara DB",
  address_line2: null,
  postcode: "50450",
  city: "Kuala Lumpur",
  state_code: "14",
  country_code: "MY",
  phone: "+60312345678",
  email: "billing@example.com",
  website: null,
  bank_name: "Maybank",
  bank_account_name: "Digital Billing Sdn Bhd",
  bank_account_no: "5140-1234-5678",
  swift: "MBBEMYKL",
  jompay_biller_code: null,
  remittance_email: "ar@example.com",
  brand_color: "#2E45A9",
  accent_color: "#1F9D57",
  payment_terms_days: "30",
};

describe("CompanyProfileForm (read mode)", () => {
  it("renders every group as text with no form controls", () => {
    const { container } = render(
      <CompanyProfileForm
        mode="read"
        fields={FIELDS}
        logoAssetVersionId="INVASV00000001"
      />,
    );
    for (const title of ["Company", "Payment", "Branding", "Defaults"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(
      screen.getAllByText("Digital Billing Sdn Bhd", { selector: "dd" })[0],
    ).toBeInTheDocument();
    expect(screen.getByText("C1234567890")).toBeInTheDocument();
    expect(screen.getByText("MBBEMYKL")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    expect(
      container.querySelector("input, textarea, select, button"),
    ).toBeNull();
  });

  it("derives the state and country labels from their codes", () => {
    render(
      <CompanyProfileForm
        fields={FIELDS}
        logoAssetVersionId="INVASV00000001"
      />,
    );
    expect(
      screen.getByText("Wilayah Persekutuan Kuala Lumpur"),
    ).toBeInTheDocument();
    expect(screen.getByText("Malaysia")).toBeInTheDocument();
  });

  it("shows a 20x20 swatch per valid colour", () => {
    render(
      <CompanyProfileForm
        fields={FIELDS}
        logoAssetVersionId="INVASV00000001"
      />,
    );
    const swatches = screen.getAllByTestId("colour-swatch");
    expect(swatches).toHaveLength(2);
    expect(swatches[0]?.querySelector("rect")).toHaveAttribute(
      "fill",
      "#2E45A9",
    );
    expect(swatches[0]).toHaveAttribute("width", "20");
    expect(swatches[0]).toHaveAttribute("height", "20");
  });

  it("omits the swatch for a malformed colour but still shows the value", () => {
    render(
      <CompanyProfileForm
        fields={{ ...FIELDS, brand_color: "red; background:url(x)" }}
        logoAssetVersionId={null}
      />,
    );
    expect(screen.getAllByTestId("colour-swatch")).toHaveLength(1);
    expect(screen.getByText("red; background:url(x)")).toBeInTheDocument();
  });

  it("points the logo <img> at the GET route", () => {
    render(
      <CompanyProfileForm
        fields={FIELDS}
        logoAssetVersionId="INVASV00000001"
      />,
    );
    expect(screen.getByRole("img", { name: "Company logo" })).toHaveAttribute(
      "src",
      "/administration/invoice-settings/company-profile/logo/INVASV00000001",
    );
  });

  it("shows no <img> and a dash when there is no logo", () => {
    render(<CompanyProfileForm fields={FIELDS} logoAssetVersionId={null} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders a dash for every blank optional field", () => {
    render(<CompanyProfileForm fields={FIELDS} logoAssetVersionId={null} />);
    // sst_reg_no, website, jompay_biller_code, logo (address_line2 is folded
    // into the address block).
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  it("renders an incomplete DRAFT without throwing", () => {
    render(
      <CompanyProfileForm
        fields={{ company_name: "Half Done" }}
        logoAssetVersionId={null}
      />,
    );
    expect(screen.getByText("Half Done")).toBeInTheDocument();
  });
});

describe("VersionHistoryTable (kind=profile)", () => {
  const ROWS: ProfileHistoryRow[] = [
    {
      versionNo: 2,
      status: "ACTIVE",
      createdBy: "Alice",
      createdAt: new Date("2026-10-05T00:00:00Z"),
      activatedAt: new Date("2026-10-05T01:00:00Z"),
      retiredAt: null,
      changeNote: "New bank",
      usedByCount: 3,
    },
    {
      versionNo: 1,
      status: "RETIRED",
      createdBy: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      activatedAt: null,
      retiredAt: null,
      changeNote: null,
      usedByCount: 1,
    },
  ];

  it("shows used-by counts, no Layout column, no Default chip, no .hbs download", () => {
    const { container } = render(
      <VersionHistoryTable
        kind="profile"
        rows={ROWS}
        shownVersionId="2"
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
    const counts = screen.getAllByTestId("used-by").map((c) => c.textContent);
    expect(counts).toEqual(["3 invoices", "1 invoice"]);
    expect(screen.queryByText("Layout")).toBeNull();
    expect(container.querySelector('[data-default="true"]')).toBeNull();
    expect(screen.queryByText(/Download/)).toBeNull();
    const view = screen.getAllByRole("link", { name: /View/ });
    expect(view.map((l) => l.getAttribute("href"))).toEqual([
      "?tab=edit&version=2",
      "?tab=edit&version=1",
    ]);
  });

  it("shows the empty copy for no versions", () => {
    render(
      <VersionHistoryTable
        kind="profile"
        rows={[]}
        shownVersionId=""
        locale="en-MY"
        timezone="Asia/Kuala_Lumpur"
      />,
    );
    expect(
      screen.getByText("No company profile versions yet."),
    ).toBeInTheDocument();
  });
});

describe("CompanyProfileForm (edit mode, bm59)", () => {
  const mockSave = vi.mocked(saveProfileDraftAction);
  const TOKEN = "2026-10-10T01:02:03.123456Z";

  beforeEach(() => {
    vi.clearAllMocks();
    mockSave.mockResolvedValue({
      ok: true,
      versionNo: 3,
      draftToken: TOKEN,
      changed: true,
    });
  });

  function renderEdit(
    fields: Record<string, string | null> = FIELDS,
    token: string | null = null,
  ) {
    return render(
      <CompanyProfileForm
        mode="edit"
        fields={fields}
        logoAssetVersionId="INVASV00000001"
        expectedDraftToken={token}
      />,
    );
  }

  function input(key: string): HTMLInputElement {
    return document.getElementById(`profile-${key}`) as HTMLInputElement;
  }

  function change(key: string, value: string): void {
    fireEvent.change(input(key), { target: { value } });
  }

  function save(): void {
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  }

  // The message the SERVER schema gives for this value — the form must show
  // the same one (one schema, TS rule 5).
  function serverMessage(key: string, value: string): string {
    const r = saveProfileDraftInputSchema.safeParse({
      fields: { [key]: value },
      expectedDraftToken: null,
    });
    if (r.success) throw new Error(`${key}=${value} is valid on the server`);
    return r.error.issues[0]!.message;
  }

  it("pre-fills inputs from the shown version, shows the country read-only, and disables Save while pristine", () => {
    renderEdit();
    expect(input("company_name").value).toBe("Digital Billing Sdn Bhd");
    expect(input("tin").value).toBe("C1234567890");
    expect(input("sst_reg_no").value).toBe("");
    expect(screen.getByText("Malaysia")).toBeInTheDocument();
    expect(input("country_code").tagName).toBe("P");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    // The logo is shown read-only; there is no logo input.
    expect(
      screen.getByRole("img", { name: "Company logo" }),
    ).toBeInTheDocument();
    expect(input("logo_asset_version_id")).toBeNull();
  });

  it.each<[string, string]>([
    ["tin", "C123"],
    ["sst_reg_no", "W101808-31000001"],
    ["postcode", "5045"],
    ["swift", "MBBEMYK"],
    ["email", "not-an-email"],
    ["brand_color", "red"],
    ["website", "http://x.example"],
    ["jompay_biller_code", "12A45"],
    ["payment_terms_days", "121"],
  ])(
    "rejects an invalid %s (%s) client-side with the server's message, sending nothing",
    async (key, value) => {
      renderEdit();
      change(key, value);
      save();
      expect(
        await screen.findByText(serverMessage(key, value)),
      ).toBeInTheDocument();
      expect(input(key)).toHaveAttribute("aria-invalid", "true");
      expect(mockSave).not.toHaveBeenCalled();
    },
  );

  it("accepts blanks and values the server normalises, and saves the raw values with the token", async () => {
    renderEdit(FIELDS, TOKEN);
    change("tin", " c12345678901 ");
    change("company_name", "");
    save();
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const payload = mockSave.mock.calls[0]![0] as {
      fields: Record<string, string>;
      expectedDraftToken: string | null;
    };
    expect(payload.expectedDraftToken).toBe(TOKEN);
    expect(payload.fields.tin).toBe(" c12345678901 ");
    expect(payload.fields.company_name).toBe("");
    expect(payload.fields.country_code).toBe("MY");
    expect(payload.fields).not.toHaveProperty("logo_asset_version_id");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Draft profile v3 saved — not used on invoices",
      ),
    );
  });

  it("a save that changed nothing says so instead of 'saved'", async () => {
    mockSave.mockResolvedValue({
      ok: true,
      versionNo: 3,
      draftToken: TOKEN,
      changed: false,
    });
    renderEdit(FIELDS, TOKEN);
    change("city", "Kuala Lumpur ");
    save();
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(NO_CHANGES_MESSAGE),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("DRAFT_CONFLICT is a Warning toast with Reload", async () => {
    mockSave.mockResolvedValue({ ok: false, code: "DRAFT_CONFLICT" });
    renderEdit(FIELDS, TOKEN);
    change("city", "Putrajaya");
    save();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    const [message, options] = vi.mocked(toast.warning).mock.calls[0]!;
    expect(message).toBe("Another user changed the draft — reload to see it.");
    const action = (
      options as { action: { label: string; onClick: () => void } }
    ).action;
    expect(action.label).toBe("Reload");
    action.onClick();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("maps a server VALIDATION_ERROR onto the field", async () => {
    mockSave.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      fieldErrors: { swift: ["SWIFT refused by the server"] },
    });
    renderEdit();
    change("city", "Putrajaya");
    save();
    expect(
      await screen.findByText("SWIFT refused by the server"),
    ).toBeInTheDocument();
    expect(input("swift")).toHaveAttribute("aria-invalid", "true");
  });

  it("shows a Warning contrast hint when white text on the colour is below 4.5:1", async () => {
    renderEdit();
    const hint = () => document.getElementById("profile-brand_color-contrast");
    // White on #2E45A9 is about 8.3:1, so no hint; the fixture's accent
    // #1F9D57 is about 3.5:1 and already carries one.
    expect(hint()).toBeNull();
    expect(
      document.getElementById("profile-accent_color-contrast"),
    ).toHaveTextContent(/3\.5:1, below 4\.5:1/);
    change("brand_color", "#FFD700");
    await waitFor(() => expect(hint()).toHaveTextContent(/below 4\.5:1/));
    expect(input("brand_color")).toHaveAttribute(
      "aria-describedby",
      "profile-brand_color-contrast",
    );
    // Non-blocking: the save still goes through.
    save();
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
  });

  it("keeps a 20x20 swatch in step with the colour input", async () => {
    renderEdit();
    expect(screen.getAllByTestId("colour-swatch")).toHaveLength(2);
    change("accent_color", "#00FF00");
    await waitFor(() =>
      expect(
        screen.getAllByTestId("colour-swatch")[1]?.querySelector("rect"),
      ).toHaveAttribute("fill", "#00FF00"),
    );
    change("accent_color", "#00FF0");
    await waitFor(() =>
      expect(screen.getAllByTestId("colour-swatch")).toHaveLength(1),
    );
  });

  it("explains that a blank SST no. is hidden on the invoice", () => {
    renderEdit();
    const hint = screen.getByText("Hidden on the invoice when blank");
    expect(input("sst_reg_no")).toHaveAttribute("aria-describedby", hint.id);
  });

  it("Create a draft focuses the form's first field", () => {
    render(
      <>
        <CreateDraftButton />
        <CompanyProfileForm
          mode="edit"
          fields={{}}
          logoAssetVersionId={null}
          expectedDraftToken={null}
        />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create a draft" }));
    expect(document.activeElement?.id).toBe(PROFILE_FIRST_FIELD_ID);
  });
});

describe("CompanyProfileForm activate (bm61)", () => {
  const mockActivate = vi.mocked(activateProfileAction);
  const TOKEN = "2026-10-10T01:02:03.123456Z";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderDraft(
    fields: Record<string, string | null> = FIELDS,
    active: Record<string, string | null> | null = FIELDS,
  ) {
    return render(
      <CompanyProfileForm
        mode="edit"
        fields={fields}
        logoAssetVersionId="INVASV00000001"
        expectedDraftToken={TOKEN}
        draftVersion={4}
        activeFields={active}
      />,
    );
  }

  function openDialog(): void {
    fireEvent.click(screen.getByRole("button", { name: "Activate v4" }));
  }

  async function confirmWithNote(note = "Quarterly refresh"): Promise<void> {
    fireEvent.change(await screen.findByLabelText("Change note (required)"), {
      target: { value: note },
    });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (b) => b.textContent === "Activate v4",
      )!,
    );
  }

  it("is not offered without a working draft", () => {
    render(
      <CompanyProfileForm
        mode="edit"
        fields={FIELDS}
        logoAssetVersionId={null}
        expectedDraftToken={null}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Activate/ })).toBeNull();
  });

  it('reads "Save draft first" and is disabled while the form has unsaved edits', () => {
    renderDraft();
    expect(screen.getByRole("button", { name: "Activate v4" })).toBeEnabled();
    fireEvent.change(document.getElementById("profile-city")!, {
      target: { value: "Ipoh" },
    });
    expect(
      screen.getByRole("button", { name: "Save draft first" }),
    ).toBeDisabled();
  });

  it("lists label: old → new and shows no bank warning for a non-payment change", async () => {
    renderDraft({ ...FIELDS, city: "Ipoh" });
    openDialog();
    const summary = await screen.findByTestId("activate-summary");
    expect(summary).toHaveTextContent("City: Kuala Lumpur → Ipoh");
    expect(screen.queryByText(BANK_CHANGE_WARNING)).toBeNull();
  });

  it("shows the bank warning only when a payment field differs, account numbers in full", async () => {
    renderDraft({ ...FIELDS, bank_account_no: "9999-0000-1111" });
    openDialog();
    expect(await screen.findByTestId("activate-summary")).toHaveTextContent(
      "Account no.: 5140-1234-5678 → 9999-0000-1111",
    );
    expect(screen.getByRole("note")).toHaveTextContent(BANK_CHANGE_WARNING);
  });

  it("the first activation (no ACTIVE version) shows the bank warning", async () => {
    renderDraft(FIELDS, null);
    openDialog();
    expect(await screen.findByRole("note")).toHaveTextContent(
      BANK_CHANGE_WARNING,
    );
  });

  it("sends the draft version, token and note, and toasts success", async () => {
    mockActivate.mockResolvedValue({
      ok: true,
      configVersion: 4,
      retiredVersion: 3,
    });
    renderDraft();
    openDialog();
    await confirmWithNote();
    await waitFor(() =>
      expect(mockActivate).toHaveBeenCalledWith({
        configVersion: 4,
        expectedDraftToken: TOKEN,
        changeNote: "Quarterly refresh",
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Company profile v4 activated",
      ),
    );
  });

  it("shows the server's logo-checksum refusal in the dialog", async () => {
    mockActivate.mockResolvedValue({
      ok: false,
      code: "ASSET_CHECKSUM_MISMATCH",
    });
    renderDraft();
    openDialog();
    await confirmWithNote();
    expect(
      await screen.findByText(
        "The stored logo failed verification. Upload the logo again. Nothing was activated.",
      ),
    ).toBeInTheDocument();
  });

  it("PROFILE_LOGO_REQUIRED shows in the dialog and inline by the logo field", async () => {
    mockActivate.mockResolvedValue({
      ok: false,
      code: "PROFILE_LOGO_REQUIRED",
    });
    renderDraft();
    openDialog();
    await confirmWithNote();
    const messages = await screen.findAllByText(
      "Upload a logo before activating the profile.",
    );
    expect(messages).toHaveLength(2);
    expect(
      messages.some((m) => m.className.includes("--color-danger-700")),
    ).toBe(true);
  });
});

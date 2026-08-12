import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FormProvider, useForm } from "react-hook-form";

import {
  CharacteristicsEditor,
  listToRecord,
  recordToList,
} from "@/components/products/ordering/characteristics-editor";
import type { WizardFormValues } from "@/components/products/ordering/wizard-form-types";

// pm29-spec §Verification checklist — "characteristics record<->list
// translation" (the pm21 boundary-translation pattern, reused for the
// ordering module's own `CharacteristicsRecord`).
describe("recordToList / listToRecord", () => {
  it("round-trips a record through the list shape unchanged", () => {
    const record = { SST_ID: "01", SD_ID: "A0C4E2" };
    expect(listToRecord(recordToList(record))).toEqual(record);
  });

  it("recordToList produces one {key,value} entry per record key", () => {
    expect(recordToList({ A: "1", B: "2" })).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ]);
  });

  it("listToRecord drops rows with a blank key", () => {
    expect(
      listToRecord([
        { key: "A", value: "1" },
        { key: "", value: "ignored" },
      ]),
    ).toEqual({ A: "1" });
  });
});

function Harness({
  defaultCharacteristics = [],
}: {
  defaultCharacteristics?: { key: string; value: string }[];
}): React.JSX.Element {
  const form = useForm<WizardFormValues>({
    defaultValues: {
      quantity: 1,
      startDate: "2026-08-12",
      characteristicsList: defaultCharacteristics,
      overrides: [],
    },
  });
  return (
    <FormProvider {...form}>
      <CharacteristicsEditor isSubmitting={false} />
    </FormProvider>
  );
}

describe("CharacteristicsEditor", () => {
  it("starts empty when no rows are prefilled", () => {
    render(<Harness />);
    expect(
      screen.queryByLabelText("Characteristic 1 key"),
    ).not.toBeInTheDocument();
  });

  it("prefills one row per characteristic", () => {
    render(
      <Harness defaultCharacteristics={[{ key: "SST_ID", value: "01" }]} />,
    );
    expect(screen.getByLabelText("Characteristic 1 key")).toHaveValue("SST_ID");
    expect(screen.getByLabelText("Characteristic 1 value")).toHaveValue("01");
  });

  it("'Add characteristic' appends a blank row, and it can be removed", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(
      screen.getByRole("button", { name: "Add characteristic" }),
    );
    expect(screen.getByLabelText("Characteristic 1 key")).toHaveValue("");

    await user.click(
      screen.getByRole("button", { name: "Remove characteristic 1" }),
    );
    expect(
      screen.queryByLabelText("Characteristic 1 key"),
    ).not.toBeInTheDocument();
  });
});

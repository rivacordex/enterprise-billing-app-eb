import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billTemplateFamily } from "@/db/schema/billing/bill-template-family";
import type { BillTemplateFamily } from "@/types/billing";

// bm64-spec §4 — read-only repository over `bill_template_family` (`app_runtime`
// holds SELECT only). Used by bm65 capture; nothing else reads the family yet.
export const billTemplateFamilyRepository = {
  // The default family (Standard, `BTF00000001`), or `null`. `btf_one_default_uq`
  // guarantees at most one.
  async findDefault(tx: Database): Promise<BillTemplateFamily | null> {
    const [row] = await tx
      .select()
      .from(billTemplateFamily)
      .where(eq(billTemplateFamily.isDefault, true))
      .limit(1);
    return row ?? null;
  },

  async findById(tx: Database, id: string): Promise<BillTemplateFamily | null> {
    const [row] = await tx
      .select()
      .from(billTemplateFamily)
      .where(eq(billTemplateFamily.billTemplateFamilyId, id))
      .limit(1);
    return row ?? null;
  },
};

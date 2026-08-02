"use server";

import { db } from "@/db/client";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";

export type GlHealthResult = {
  unmappedCount: number;
  unmappedAccounts: string[];
};

// V5 live read — never cached (force-dynamic pages, Module Inv. #2).
// A non-zero count means at least one pgledger account has no resolved GL
// code; the eventual export (ac14) would be corrupt. This is "the page's most
// important pixel" (ac12-spec §2.4 / plan P4.4).
export async function getGlHealth(): Promise<GlHealthResult> {
  const [unmappedCount, unmappedAccounts] = await Promise.all([
    ledgerRepository.countUnmappedAccounts(db),
    ledgerRepository.findUnmappedAccountNames(db),
  ]);
  return { unmappedCount, unmappedAccounts };
}

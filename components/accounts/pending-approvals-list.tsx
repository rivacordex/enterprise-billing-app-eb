"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { approveDocumentAction } from "@/actions/accounts/approve-document";
import { Button } from "@/components/ui/button";
import { DocStateBadge } from "@/components/accounts/doc-state-badge";
import type { Document } from "@/types/accounts";

export interface PendingApprovalsListProps {
  documents: Document[];
  currentUserId: string;
}

export function PendingApprovalsList({
  documents,
  currentUserId,
}: PendingApprovalsListProps): React.JSX.Element {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleApprove(
    documentId: string,
    lastModified: Date,
  ): Promise<void> {
    setBusyId(documentId);
    setError(null);
    try {
      const result = await approveDocumentAction({ documentId, lastModified });
      if (!result.ok) {
        setError(
          result.code === "SELF_APPROVAL"
            ? "You created this document — a different manager must approve it."
            : "Approval failed. Please try again.",
        );
        return;
      }
      router.refresh();
    } catch {
      setError("Approval failed. Please try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (documents.length === 0) {
    return (
      <p className="text-body-sm text-muted-foreground">
        No documents pending approval for this Financial Account.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-body-sm text-destructive">{error}</p>}
      <div
        role="list"
        className="divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-md border border-[color:var(--border-default)]"
      >
        {documents.map((doc) => (
          <div
            key={doc.documentId}
            role="listitem"
            className="flex items-center gap-4 px-3 py-2.5"
          >
            <span className="font-mono text-body-sm text-muted-foreground">
              {doc.documentId}
            </span>
            <DocStateBadge state="pending_approval" />
            <span className="flex-1 text-body-sm text-muted-foreground">
              {doc.reasonCode} — {doc.totalAmount} {doc.currency}
            </span>
            <Button
              type="button"
              size="sm"
              disabled={
                busyId === doc.documentId || doc.createdBy === currentUserId
              }
              onClick={() =>
                void handleApprove(doc.documentId, doc.lastModified)
              }
              title={
                doc.createdBy === currentUserId
                  ? "You created this document — a different manager must approve it"
                  : undefined
              }
            >
              {busyId === doc.documentId ? "Approving…" : "Approve"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

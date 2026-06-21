import { z } from "zod";

import { AUDIT_EVENT_TYPES, type AuditEventType } from "@/types/audit";

// Lenient by design (um24-spec §24.2): every field falls back to its
// default on a parse failure rather than throwing, so a tampered or stale
// URL never 500s the page — it just loads unfiltered.
const eventTypeSchema = z
  .string()
  .refine((v): v is AuditEventType =>
    (AUDIT_EVENT_TYPES as readonly string[]).includes(v),
  )
  .nullable()
  .catch(null);

export const auditLogSearchParamsSchema = z.object({
  eventType: eventTypeSchema,
  actorUserId: z.string().uuid().nullable().catch(null),
  dateFrom: z.string().date().nullable().catch(null),
  dateTo: z.string().date().nullable().catch(null),
  page: z.coerce.number().int().min(1).catch(1),
});

export type AuditLogSearchParams = z.infer<typeof auditLogSearchParamsSchema>;

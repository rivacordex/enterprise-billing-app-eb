// ac14-spec §3.4 — validation schema for the redate-and-post action.
// Takes the draft document to correct and the new entry date (event_at).

import { z } from "zod";

export const redateAndPostSchema = z.object({
  documentId: z.string().min(1),
  eventAt: z
    .string()
    .date({ message: "eventAt must be a valid date (YYYY-MM-DD)" }),
  lastModified: z
    .string()
    .datetime({ message: "lastModified must be an ISO datetime string" }),
});

export type RedateAndPostInput = z.infer<typeof redateAndPostSchema>;

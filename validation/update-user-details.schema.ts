import { z } from "zod";

export const updateUserDetailsSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  userName: z.string().trim().min(1, "Name is required").max(255),
  userPhonenum: z
    .string()
    .max(50, "Phone number is too long")
    .trim()
    .nullish()
    .transform((v) => v || null),
});

export type UpdateUserDetailsInput = z.infer<typeof updateUserDetailsSchema>;

// `UserForm`'s edit mode (um11-spec §11.5) renders only the editable fields
// — `userId` is injected by `UserDetail` from the selected user, not
// entered by the user — so its resolver validates this derived schema
// rather than the full action-boundary schema above. `.omit` keeps the
// per-field rules identical to `updateUserDetailsSchema`.
export const editUserDetailsFieldsSchema = updateUserDetailsSchema.omit({
  userId: true,
});

export type EditUserDetailsFields = z.infer<typeof editUserDetailsFieldsSchema>;

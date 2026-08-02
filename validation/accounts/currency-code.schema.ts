import { z } from "zod";

// Shared currency code validator: exactly three uppercase ASCII letters (ISO 4217).
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: "Currency must be a 3-character code" });

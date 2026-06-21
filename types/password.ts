// um25-spec §"Policy source". Loaded once from env vars in `lib/config.ts`
// and threaded explicitly into `validation/password.ts` and
// `services/password.ts` — never re-read from `process.env` outside
// `lib/config.ts`.
export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
  specialChars: string;
}

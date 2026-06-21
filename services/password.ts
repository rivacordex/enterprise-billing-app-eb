import { randomInt } from "node:crypto";

import type { PasswordPolicy } from "@/types/password";

const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";

// Fisher-Yates shuffle using `crypto.randomInt` exclusively (Inv. #1 — no
// `Math.random()` anywhere in this module).
function shuffle(chars: string[]): string[] {
  const result = [...chars];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function randomChar(pool: string): string {
  return pool[randomInt(pool.length)]!;
}

// um25-spec §"Temp password generation". Draws one char from each enabled
// required class, fills the remainder of `policy.minLength` from the union
// of all enabled pools, then shuffles — guaranteeing the result always
// satisfies `buildPasswordSchema(policy)` without a generate-and-retry loop.
// Pure and side-effect-free; never logs the result (Inv. #1).
export function generateTempPassword(policy: PasswordPolicy): string {
  const requiredPools: string[] = [];
  if (policy.requireUppercase) requiredPools.push(UPPERCASE);
  if (policy.requireLowercase) requiredPools.push(LOWERCASE);
  if (policy.requireNumber) requiredPools.push(DIGITS);
  if (policy.requireSpecial) requiredPools.push(policy.specialChars);

  const allChars =
    requiredPools.length > 0
      ? requiredPools.join("")
      : UPPERCASE + LOWERCASE + DIGITS;

  const chars = requiredPools.map((pool) => randomChar(pool));
  while (chars.length < policy.minLength) {
    chars.push(randomChar(allChars));
  }

  return shuffle(chars).join("");
}

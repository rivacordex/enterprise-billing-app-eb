import { getAppTimezone } from "@/services/system-config/app-config-read.service";

// The zone rating buckets the billing month in: rating.period_of()
// (db/migrations/0034_rating.sql) and rl.py's period_of both hard-code it
// (rating X1, a deploy-time constant per rm15). The bill run dates usage and
// prices in APP_TIMEZONE (the flow's `business_timezone` input), so the two
// must agree or the period window and the rated month disagree on every
// record from midnight to the zone offset on the 1st (the bm73 manual-run
// failure). tests/guardrails/billrun-business-timezone.test.ts pins this
// constant to the rating literal.
export const RATING_BILLING_TIMEZONE = "Asia/Kuala_Lumpur";

// True when APP_TIMEZONE matches rating's billing zone. Trigger and rerun
// refuse to start the engine otherwise (BUSINESS_TIMEZONE_MISMATCH), so a
// deployment left on the UTC default fails loudly instead of mis-windowing.
export function isBusinessTimezoneAligned(): boolean {
  return getAppTimezone() === RATING_BILLING_TIMEZONE;
}

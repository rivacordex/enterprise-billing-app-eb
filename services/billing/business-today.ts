import { todayInZone } from "@/lib/timezone";
import { getAppTimezone } from "@/services/system-config/app-config-read.service";

// bm02. The business "today" (calendar day `YYYY-MM-DD` in the configured app
// timezone). Resolved ONCE per page render and threaded into both
// `materializeDueRuns` and `listRuns`, so a render that straddles local
// midnight can never materialize a run for day N and then judge it against
// day N+1 in the same load.
export function getBusinessToday(): string {
  return todayInZone(new Date(), getAppTimezone());
}

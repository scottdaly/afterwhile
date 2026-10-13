export function timeZoneOf(timeZone?: string): string {
  return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** YYYY-MM-DD in the given IANA zone (the machine zone when omitted). */
export function localDay(iso: string, timeZone?: string): string {
  const tz = timeZoneOf(timeZone);
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  return formatted;
}

export function localTime(iso: string, timeZone?: string): string {
  const tz = timeZoneOf(timeZone);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** First instant (ms) of the next local day after `now`. */
export function endOfLocalDay(now: Date, timeZone?: string): number {
  const tz = timeZoneOf(timeZone);
  const day = localDay(now.toISOString(), tz);
  let lo = now.getTime();
  let hi = lo + 36 * 60 * 60 * 1000;
  if (localDay(new Date(lo).toISOString(), tz) !== day) return lo;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (localDay(new Date(mid).toISOString(), tz) === day) lo = mid;
    else hi = mid;
  }
  return hi;
}

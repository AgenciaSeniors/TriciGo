// ============================================================
// TriciGo — Date & Time Utilities
// Timezone: America/Havana (Cuba Standard Time)
// ============================================================

const HAVANA_TIMEZONE = 'America/Havana';

/**
 * Format an ISO timestamp for display in Havana timezone.
 */
export function formatDateTime(
  isoString: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const date = new Date(isoString);
  return date.toLocaleString('es-CU', {
    timeZone: HAVANA_TIMEZONE,
    ...options,
  });
}

/**
 * Format a date as "dd/MM/yyyy"
 */
export function formatDate(isoString: string): string {
  return formatDateTime(isoString, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Format time as "HH:mm"
 */
export function formatTime(isoString: string): string {
  return formatDateTime(isoString, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Format duration in seconds to human-readable string.
 * Examples:
 *   formatDuration(90) → "1 min 30 s"
 *   formatDuration(3661) → "1 h 1 min"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours > 0) {
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0
    ? `${minutes} min ${remainingSeconds} s`
    : `${minutes} min`;
}

/**
 * Format distance in meters to human-readable string.
 * Examples:
 *   formatDistance(500) → "500 m"
 *   formatDistance(2500) → "2.5 km"
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Get relative day label ("Hoy", "Ayer") or short date, using calendar-day
 * comparison in Havana timezone (not millisecond diff).
 */
export function getRelativeDay(
  isoString: string,
  todayLabel: string,
  yesterdayLabel: string,
  locale = 'es-CU',
): string {
  const date = new Date(isoString);
  const now = new Date();

  // Compare calendar dates in Havana timezone (YYYY-MM-DD via en-CA)
  const dateDay = date.toLocaleDateString('en-CA', { timeZone: HAVANA_TIMEZONE });
  const todayDay = now.toLocaleDateString('en-CA', { timeZone: HAVANA_TIMEZONE });

  if (dateDay === todayDay) return todayLabel;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayDay = yesterday.toLocaleDateString('en-CA', { timeZone: HAVANA_TIMEZONE });
  if (dateDay === yesterdayDay) return yesterdayLabel;

  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: HAVANA_TIMEZONE,
  });
}

/**
 * Get relative time string (e.g., "hace 5 min", "hace 2 h")
 */
export function getRelativeTime(isoString: string, locale = 'es'): string {
  const now = Date.now();
  const date = new Date(isoString).getTime();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (locale === 'es') {
    if (diffSec < 60) return 'ahora';
    if (diffMin < 60) return `hace ${diffMin} min`;
    if (diffHour < 24) return `hace ${diffHour} h`;
    if (diffDay === 1) return 'ayer';
    return `hace ${diffDay} días`;
  }

  // English fallback
  if (diffSec < 60) return 'now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return 'yesterday';
  return `${diffDay} days ago`;
}

const MONTH_NAMES_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/**
 * Format a timestamp in one of three styles:
 *  - `relative`: "hace 5 min", "hace 2h", "hace 3d", "ayer"
 *  - `absolute`: "22 mar 2026, 14:30"
 *  - `short`:    "22 mar"
 *
 * Uses plain Date operations — no external library.
 */
export function formatTimestamp(
  date: string | Date,
  style: 'relative' | 'absolute' | 'short',
): string {
  const d = typeof date === 'string' ? new Date(date) : date;

  if (style === 'relative') {
    const now = Date.now();
    const diffMs = now - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return 'ahora';
    if (diffMin < 60) return `hace ${diffMin} min`;
    if (diffHour < 24) return `hace ${diffHour}h`;
    if (diffDay === 1) return 'ayer';
    if (diffDay < 30) return `hace ${diffDay}d`;
    return `${d.getDate()} ${MONTH_NAMES_ES[d.getMonth()]}`;
  }

  if (style === 'absolute') {
    const day = d.getDate();
    const month = MONTH_NAMES_ES[d.getMonth()];
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day} ${month} ${year}, ${hours}:${minutes}`;
  }

  // short
  const day = d.getDate();
  const month = MONTH_NAMES_ES[d.getMonth()];
  return `${day} ${month}`;
}

/**
 * Convert an ETA in minutes to a clock-time string (e.g. "2:35 PM").
 * Uses the device's local time.
 */
export function formatArrivalTime(etaMinutes: number): string {
  const arrival = new Date(Date.now() + etaMinutes * 60_000);
  const hours = arrival.getHours();
  const minutes = arrival.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  const m = minutes.toString().padStart(2, '0');
  return `${h}:${m} ${ampm}`;
}

/**
 * Returns the current Havana-local calendar date's midnight, expressed as a
 * UTC `Date`. Suitable for `>= midnight` Postgres `timestamptz` comparisons
 * that anchor to the user's "today" rather than UTC midnight (which can be
 * 4–5h off depending on DST).
 *
 * Robust to DST transitions because we query the OS/Intl tz database for
 * the actual instant rather than hardcoding the offset.
 *
 * Caveat: on the SPRING-FORWARD day itself (2nd Sunday of March in Cuba),
 * the result may be off by 1h from the pure-CST interpretation because
 * the offset probe at UTC noon already returns the CDT offset. The
 * missing wall-clock hour (00:00-01:00 local) doesn't exist that day
 * due to the spring-forward, so the gap is harmless for typical
 * "since-midnight" timestamptz comparisons.
 *
 * Examples:
 *   // CST (UTC-5, Nov–Mar)
 *   havanaMidnightUtc(new Date('2026-01-15T15:30:00Z')) → 2026-01-15T05:00:00Z
 *   // CDT (UTC-4, Mar–Nov DST)
 *   havanaMidnightUtc(new Date('2026-07-15T15:30:00Z')) → 2026-07-15T04:00:00Z
 *   // UTC and Havana on different calendar days (UTC 03:00 = Havana 22:00 prev day):
 *   havanaMidnightUtc(new Date('2026-01-15T03:00:00Z')) → 2026-01-14T05:00:00Z
 *
 * Cherry-picked from abandoned branch `claude/jovial-mclean-56212b`
 * (commit aa52e4c). Replaces the inline calculation that lived in
 * apps/driver/app/(tabs)/index.tsx for the today-earnings query.
 */
export function havanaMidnightUtc(now: Date = new Date()): Date {
  // 1. Pull the Havana-local calendar date (handles the case where UTC and
  //    Havana are on different days, e.g. UTC 02:00 = Havana 21:00 yesterday).
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: HAVANA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const year = parseInt(get('year'), 10);
  const month = parseInt(get('month'), 10);
  const day = parseInt(get('day'), 10);

  // 2. Determine Havana's UTC offset for that calendar date by asking what
  //    Havana clock-hour corresponds to 12:00 UTC. CST → 7 (offset 5h),
  //    CDT → 8 (offset 4h). Robust to DST transitions because we query the
  //    OS/Intl tz database for the actual instant.
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const havanaHourAtUtcNoon = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: HAVANA_TIMEZONE,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(utcNoon),
    10,
  );
  const offsetHours = 12 - havanaHourAtUtcNoon;

  // 3. Havana 00:00 wall-clock = UTC `offsetHours`:00 of the same date.
  return new Date(Date.UTC(year, month - 1, day, offsetHours, 0, 0));
}

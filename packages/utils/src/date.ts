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

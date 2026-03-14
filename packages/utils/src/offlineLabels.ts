// ============================================================
// TriciGo — Offline Action Labels
// Maps offline queue action names to i18n keys.
// ============================================================

const ACTION_LABELS: Record<string, { es: string; en: string; icon: string }> = {
  'ride.cancel': { es: 'Cancelar viaje', en: 'Cancel ride', icon: 'close-circle-outline' },
  'review.submit': { es: 'Enviar reseña', en: 'Submit review', icon: 'star-outline' },
  'incident.sos': { es: 'Reporte de emergencia', en: 'Emergency report', icon: 'warning-outline' },
  'support.createTicket': { es: 'Ticket de soporte', en: 'Support ticket', icon: 'chatbubble-outline' },
  'location.flush': { es: 'Sincronizar GPS', en: 'Sync GPS data', icon: 'navigate-outline' },
};

/**
 * Get human-readable label for an offline queue action.
 */
export function getOfflineActionLabel(action: string, locale: 'es' | 'en' = 'es'): string {
  return ACTION_LABELS[action]?.[locale] ?? action;
}

/**
 * Get icon name for an offline queue action.
 */
export function getOfflineActionIcon(action: string): string {
  return ACTION_LABELS[action]?.icon ?? 'sync-outline';
}

/**
 * Format relative time from a timestamp.
 */
export function formatTimeAgo(timestampMs: number, locale: 'es' | 'en' = 'es'): string {
  const diffMs = Date.now() - timestampMs;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) {
    return locale === 'es' ? 'ahora' : 'now';
  }
  if (diffMin < 60) {
    return locale === 'es' ? `hace ${diffMin} min` : `${diffMin} min ago`;
  }
  const diffH = Math.floor(diffMin / 60);
  return locale === 'es' ? `hace ${diffH}h` : `${diffH}h ago`;
}

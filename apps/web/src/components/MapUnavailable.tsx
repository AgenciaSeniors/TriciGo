/**
 * Visible fallback shown when NEXT_PUBLIC_MAPBOX_TOKEN is missing, instead of a
 * silent gray Mapbox canvas (ride-flow audit #13). Fills its parent container,
 * so it works both as a full-component early return and inside a fixed-size
 * map slot. Misconfiguration only — prod ships a valid token.
 */
export function MapUnavailable({ message }: { message?: string }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        minHeight: 240,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 24,
        textAlign: 'center',
        background: 'var(--bg-card, #1a1a1a)',
        color: 'var(--text-secondary, #9ca3af)',
        borderRadius: 'inherit',
      }}
    >
      <span style={{ fontSize: 32 }} aria-hidden>
        🗺️
      </span>
      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #fff)' }}>
        Mapa no disponible
      </span>
      <span style={{ fontSize: 12 }}>
        {message ?? 'Falta la configuración del mapa. Intenta de nuevo más tarde.'}
      </span>
    </div>
  );
}

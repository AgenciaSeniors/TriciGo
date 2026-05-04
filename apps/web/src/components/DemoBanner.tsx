/**
 * DemoBanner — barra top persistente cuando la web corre en modo demo.
 *
 * Espejo del componente móvil `apps/client/src/components/DemoBanner.tsx`.
 * Sólo se renderiza si `DEMO_MODE=true`. Queda fija al top, no bloquea
 * taps del contenido (pointerEvents: none), y tiene el mismo look
 * on-brand Cuban Modern (naranja cálido, monoespaciado letter-spaced).
 *
 * Propósito: el equipo nunca olvida que está en una build no-prod y que
 * los datos que se generan NO son reales.
 */
'use client';

import { DEMO_MODE, DEMO_CITY, DEMO_CITY_LABEL } from '@/config/demo';

export function DemoBanner() {
  if (!DEMO_MODE) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        padding: '6px 16px',
        backgroundColor: '#FF4D00',
        textAlign: 'center',
        zIndex: 9999,
        pointerEvents: 'none',
        // Letter-spaced, mono-styled — matches the Cuban Modern brand.
        // Falls back to ui-monospace stack if the variable font is not
        // loaded yet (e.g. on first paint).
        fontFamily:
          'ui-monospace, SFMono-Regular, "Menlo", "Monaco", "Cascadia Mono", "Roboto Mono", monospace',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 2,
        color: '#FFFFFF',
      }}
    >
      {`MODO DEMO · ${DEMO_CITY_LABEL[DEMO_CITY].toUpperCase()} · NO PRODUCCIÓN`}
    </div>
  );
}

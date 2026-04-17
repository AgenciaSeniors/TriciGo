'use client';

import { useMemo } from 'react';

type Driver = {
  id: string | number;
  /** Relative x (0–1), relative to map canvas */
  x: number;
  y: number;
  tone?: 'active' | 'idle' | 'alert';
};

type Props = {
  onlineDrivers: number;
  activeRides: number;
  pendingRides: number;
  /** When true, animated pulse rings spawn on active dots */
  live?: boolean;
};

/**
 * Stylised live-pulse view of driver activity across Cuba. Abstract — no real
 * geodata — so the admin gets a fast, always-available pulse without needing
 * a map token. Real Mapbox view lives on /live-map.
 *
 * The island silhouette is a simplified SVG path representing Cuba's
 * west-to-east orientation.
 */

// Approximate anchor points (relative to the 100x40 viewBox) for six major
// cities. These aren't geographically precise — they're a readable abstraction.
const CITY_ANCHORS = [
  { code: 'PR', label: 'Pinar del Río', x: 14, y: 22, tint: 'rgb(var(--ink-muted))' },
  { code: 'HAB', label: 'La Habana', x: 26, y: 18, tint: 'rgb(255 77 0)' },
  { code: 'VC', label: 'Villa Clara', x: 46, y: 21, tint: 'rgb(var(--ink-muted))' },
  { code: 'CMG', label: 'Camagüey', x: 62, y: 23, tint: 'rgb(var(--ink-muted))' },
  { code: 'HOL', label: 'Holguín', x: 78, y: 24, tint: 'rgb(var(--ink-muted))' },
  { code: 'SCU', label: 'Santiago de Cuba', x: 88, y: 28, tint: 'rgb(255 77 0)' },
] as const;

// Simplified outline of Cuba — hand-tuned for readability at 100x40.
const CUBA_PATH = `
  M 4 22
  Q 10 17 18 18
  Q 24 15 30 18
  Q 36 19 42 21
  Q 50 22 58 22
  Q 66 22 72 24
  Q 78 25 84 27
  Q 90 29 94 30
  Q 96 31 94 32
  Q 88 33 80 32
  Q 72 31 64 30
  Q 56 29 48 28
  Q 40 28 32 26
  Q 24 25 16 26
  Q 8 26 4 24
  Z
`;

export function PulseMap({ onlineDrivers, activeRides, pendingRides, live = true }: Props) {
  const drivers = useMemo<Driver[]>(() => {
    // Place drivers along the length of the island with slight vertical
    // jitter. Deterministic based on counts.
    const seeds: Driver[] = [];
    const total = Math.min(onlineDrivers || 0, 32);
    for (let i = 0; i < total; i++) {
      const t = (i + 1) / (total + 1);
      const jitter = Math.sin(i * 2.399) * 0.06;
      seeds.push({
        id: i,
        x: 0.06 + t * 0.88 + Math.cos(i * 1.7) * 0.02,
        y: 0.45 + jitter,
        tone: i < activeRides ? 'active' : i === 0 ? 'alert' : 'idle',
      });
    }
    return seeds;
  }, [onlineDrivers, activeRides]);

  return (
    <div className="relative h-[300px] w-full overflow-hidden rounded-xl bg-surface-sunken ring-1 ring-line">
      {/* Subtle brand aurora — orange + deep blue (cuba accent), not distracting */}
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-70"
        style={{
          background: `
            radial-gradient(48% 36% at 26% 38%, rgb(255 77 0 / 0.22), transparent 62%),
            radial-gradient(42% 32% at 80% 52%, rgb(0 42 143 / 0.22), transparent 60%)
          `,
        }}
      />

      {/* Lat/long-ish grid */}
      <svg className="absolute inset-0 h-full w-full opacity-[0.14]" aria-hidden="true">
        <defs>
          <pattern id="pulse-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="currentColor" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#pulse-grid)" className="text-ink" />
      </svg>

      {/* Cuba silhouette */}
      <svg
        className="absolute inset-x-4 top-1/2 -translate-y-1/2"
        viewBox="0 0 100 40"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        style={{ width: 'calc(100% - 2rem)', height: 'auto' }}
      >
        <path
          d={CUBA_PATH}
          fill="rgb(var(--surface-elevated) / 0.7)"
          stroke="rgb(var(--ink) / 0.35)"
          strokeWidth="0.4"
          strokeLinejoin="round"
        />
        {/* Isla de la Juventud — a small separate shape below the mainland */}
        <ellipse cx="22" cy="36" rx="2.4" ry="1.1" fill="rgb(var(--surface-elevated) / 0.7)" stroke="rgb(var(--ink) / 0.35)" strokeWidth="0.4" />
      </svg>

      {/* Driver dots (positioned relative to the container, aligned with island midline) */}
      {drivers.map((d) => (
        <span
          key={d.id}
          className="absolute"
          style={{
            left: `calc(1rem + ${d.x} * (100% - 2rem))`,
            top: `calc(50% + ${(d.y - 0.45) * 100}%)`,
            transform: 'translate(-50%,-50%)',
          }}
        >
          <span className="relative flex h-2 w-2">
            {live && d.tone === 'active' && (
              <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-primary-500/70" />
            )}
            <span
              className={`relative inline-flex h-2 w-2 rounded-full ${
                d.tone === 'active'
                  ? 'bg-primary-500 shadow-[0_0_8px_rgb(255,77,0,0.8)]'
                  : d.tone === 'alert'
                    ? 'bg-red-500 shadow-[0_0_6px_rgb(239,68,68,0.8)]'
                    : 'bg-ink/60'
              }`}
            />
          </span>
        </span>
      ))}

      {/* City labels */}
      {CITY_ANCHORS.map((c) => (
        <div
          key={c.code}
          className="pointer-events-none absolute flex items-center gap-1.5"
          style={{
            left: `calc(1rem + ${c.x / 100} * (100% - 2rem))`,
            top: `calc(50% + ${(c.y - 20) / 40 * 100}%)`,
            transform: 'translate(-50%,-50%)',
          }}
        >
          <span
            className="h-2 w-2 rounded-full ring-2 ring-surface-elevated"
            style={{ background: c.tint }}
          />
          <span className="whitespace-nowrap rounded-full bg-surface-elevated/80 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-ink shadow-elev-1 backdrop-blur">
            {c.code}
          </span>
        </div>
      ))}

      {/* Context label */}
      <span className="absolute left-3 top-3 rounded-full bg-surface-elevated/80 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-muted shadow-elev-1 backdrop-blur">
        Cuba · pulso en vivo
      </span>

      {/* Stats strip */}
      <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-2 rounded-xl border border-line bg-surface-elevated/80 px-3 py-2 backdrop-blur-md">
        <div className="flex flex-col">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-subtle">En línea</span>
          <span className="font-editorial text-xl leading-none italic text-ink" data-tabular>
            {onlineDrivers}
          </span>
        </div>
        <div className="h-8 w-px bg-line" aria-hidden="true" />
        <div className="flex flex-col">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-subtle">Activos</span>
          <span className="font-editorial text-xl leading-none italic text-primary-500" data-tabular>
            {activeRides}
          </span>
        </div>
        <div className="h-8 w-px bg-line" aria-hidden="true" />
        <div className="flex flex-col">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-subtle">Buscando</span>
          <span className="font-editorial text-xl leading-none italic text-amber-500" data-tabular>
            {pendingRides}
          </span>
        </div>
      </div>
    </div>
  );
}

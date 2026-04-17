'use client';

import type { LucideIcon } from 'lucide-react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Sparkline } from './Sparkline';

type Tone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
type Variant = 'hero' | 'default';

type Props = {
  label: string;
  value: string;
  /** Small suffix/unit shown next to the number, e.g. "CUP" or "min" */
  unit?: string;
  variant?: Variant;
  tone?: Tone;
  icon?: LucideIcon;
  /** Hint shown under the value, e.g. "vs. ayer", "últimos 7 días" */
  hint?: string;
  /** Delta percentage; positive = up, negative = down, null = unknown, 0 = flat */
  delta?: number | null;
  /** Series used for sparkline */
  trend?: number[];
  loading?: boolean;
  className?: string;
};

const TONE_ACCENTS: Record<Tone, { text: string; ring: string; spark: string; fill: string }> = {
  default: {
    text: 'text-ink',
    ring: 'ring-line',
    spark: 'text-ink-muted',
    fill: 'rgb(var(--ink-muted) / 0.16)',
  },
  primary: {
    text: 'text-primary-600 dark:text-primary-400',
    ring: 'ring-primary-500/20',
    spark: 'text-primary-500',
    fill: 'rgb(255 77 0 / 0.18)',
  },
  success: {
    text: 'text-emerald-600 dark:text-emerald-400',
    ring: 'ring-emerald-500/20',
    spark: 'text-emerald-500',
    fill: 'rgb(16 185 129 / 0.18)',
  },
  warning: {
    text: 'text-amber-600 dark:text-amber-400',
    ring: 'ring-amber-500/20',
    spark: 'text-amber-500',
    fill: 'rgb(245 158 11 / 0.18)',
  },
  danger: {
    text: 'text-red-600 dark:text-red-400',
    ring: 'ring-red-500/20',
    spark: 'text-red-500',
    fill: 'rgb(239 68 68 / 0.18)',
  },
  info: {
    text: 'text-sky-600 dark:text-sky-400',
    ring: 'ring-sky-500/20',
    spark: 'text-sky-500',
    fill: 'rgb(14 165 233 / 0.18)',
  },
};

function DeltaBadge({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-ink-subtle">
        <Minus className="h-3 w-3" />
        <span>—</span>
      </span>
    );
  }
  const up = delta > 0;
  const down = delta < 0;
  const flat = delta === 0;
  const Icon = up ? ArrowUpRight : down ? ArrowDownRight : Minus;
  const classes = up
    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    : down
      ? 'bg-red-500/10 text-red-600 dark:text-red-400'
      : 'bg-surface-sunken text-ink-subtle';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] ${classes}`}>
      <Icon className="h-3 w-3" />
      <span data-tabular>
        {flat ? '0%' : `${up ? '+' : ''}${delta.toFixed(1)}%`}
      </span>
    </span>
  );
}

export function KpiCard({
  label,
  value,
  unit,
  variant = 'default',
  tone = 'default',
  icon: Icon,
  hint,
  delta,
  trend,
  loading,
  className = '',
}: Props) {
  const t = TONE_ACCENTS[tone];
  const isHero = variant === 'hero';

  return (
    <div
      className={`
        admin-card relative flex flex-col gap-4 overflow-hidden
        ${isHero ? 'p-6 md:p-7' : 'p-5'}
        ${className}
      `}
    >
      {/* Tone wash */}
      {tone !== 'default' && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute -right-8 -top-12 h-32 w-32 rounded-full blur-3xl opacity-70 ${t.ring}`}
          style={{ background: t.fill }}
        />
      )}

      <div className="relative flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {Icon && (
            <span className={`flex h-8 w-8 items-center justify-center rounded-xl bg-surface-sunken ${t.text}`}>
              <Icon className="h-4 w-4" strokeWidth={2} />
            </span>
          )}
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">{label}</p>
        </div>
        <DeltaBadge delta={delta} />
      </div>

      <div className="relative flex items-end justify-between gap-4">
        <div className="flex items-baseline gap-1.5">
          {loading ? (
            <span className={`inline-block ${isHero ? 'h-16 w-36' : 'h-10 w-20'} animate-pulse rounded-lg bg-surface-sunken`} />
          ) : (
            <>
              <span
                className={`
                  font-editorial italic tabular leading-none
                  ${isHero ? 'text-[68px] md:text-[84px]' : 'text-[44px]'}
                  ${t.text}
                `}
                data-tabular
              >
                {value}
              </span>
              {unit && (
                <span className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-ink-subtle">
                  {unit}
                </span>
              )}
            </>
          )}
        </div>

        {trend && trend.length > 1 && !loading && (
          <Sparkline
            data={trend}
            width={isHero ? 160 : 96}
            height={isHero ? 48 : 32}
            strokeWidth={1.75}
            className={t.spark}
            fill={t.fill}
          />
        )}
      </div>

      {hint && !loading && (
        <p className="relative text-[11px] text-ink-muted">{hint}</p>
      )}
    </div>
  );
}

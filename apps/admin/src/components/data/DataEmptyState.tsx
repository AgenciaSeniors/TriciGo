'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

export type DataEmptyTone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

type Action =
  | { label: string; onClick: () => void; href?: never }
  | { label: string; href: string; onClick?: never };

type Props = {
  icon: LucideIcon;
  tone?: DataEmptyTone;
  title: string;
  body?: ReactNode;
  action?: Action;
  /** Adds extra vertical padding for standalone (non-card-embedded) usage */
  standalone?: boolean;
};

const TONE_BG: Record<DataEmptyTone, string> = {
  default: 'bg-surface-sunken text-ink-muted',
  primary: 'bg-primary-500/10 text-primary-500',
  success: 'bg-emerald-500/10 text-emerald-500',
  warning: 'bg-amber-500/10 text-amber-500',
  danger: 'bg-red-500/10 text-red-500',
  info: 'bg-sky-500/10 text-sky-500',
};

export function DataEmptyState({
  icon: Icon,
  tone = 'default',
  title,
  body,
  action,
  standalone,
}: Props) {
  return (
    <div
      className={`flex flex-col items-center gap-3 text-center ${standalone ? 'py-16' : 'py-10'}`}
    >
      <span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${TONE_BG[tone]}`}>
        <Icon className="h-5 w-5" strokeWidth={1.8} />
      </span>
      <div>
        <p className="font-display text-[15px] font-semibold text-ink">{title}</p>
        {body && <p className="mt-1 max-w-[32ch] text-[12px] text-ink-muted">{body}</p>}
      </div>
      {action &&
        (action.href ? (
          <Link
            href={action.href}
            className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12px] font-medium text-surface transition-opacity hover:opacity-90"
          >
            {action.label}
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[12px] font-medium text-surface transition-opacity hover:opacity-90"
          >
            {action.label}
          </button>
        ))}
    </div>
  );
}

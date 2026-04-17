'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type Props = {
  icon?: LucideIcon;
  /** Dot color for the icon slot (uses Tailwind ring-<color>/class) */
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
  primary: ReactNode;
  secondary?: ReactNode;
  trailing?: ReactNode;
  href?: string;
  onClick?: () => void;
};

const TONE_BG: Record<NonNullable<Props['tone']>, string> = {
  default: 'bg-surface-sunken text-ink-muted',
  primary: 'bg-primary-500/10 text-primary-500',
  success: 'bg-emerald-500/10 text-emerald-500',
  warning: 'bg-amber-500/10 text-amber-500',
  danger: 'bg-red-500/10 text-red-500',
  info: 'bg-sky-500/10 text-sky-500',
};

export function ActivityRow({
  icon: Icon,
  tone = 'default',
  primary,
  secondary,
  trailing,
  href,
  onClick,
}: Props) {
  const content = (
    <div className="flex items-center gap-3 py-2.5">
      {Icon && (
        <span
          className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${TONE_BG[tone]}`}
        >
          <Icon className="h-4 w-4" strokeWidth={1.9} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink">{primary}</div>
        {secondary && (
          <div className="truncate text-[11.5px] text-ink-subtle">{secondary}</div>
        )}
      </div>
      {trailing && (
        <div className="flex-shrink-0 text-right text-[11px] text-ink-muted">{trailing}</div>
      )}
    </div>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block -mx-2 rounded-lg px-2 transition-colors hover:bg-surface-sunken focus-visible:bg-surface-sunken"
      >
        {content}
      </a>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="block w-full -mx-2 rounded-lg px-2 text-left transition-colors hover:bg-surface-sunken"
      >
        {content}
      </button>
    );
  }
  return <div className="-mx-2 px-2">{content}</div>;
}

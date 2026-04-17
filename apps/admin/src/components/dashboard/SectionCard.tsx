'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

type Props = {
  title: string;
  /** Small eyebrow shown above the title */
  eyebrow?: string;
  description?: string;
  /** Link rendered on the right of the header */
  action?: { label: string; href: string };
  children: ReactNode;
  className?: string;
  /** When true, padding around children is removed (for lists / maps that want bleed) */
  bleed?: boolean;
};

export function SectionCard({
  title,
  eyebrow,
  description,
  action,
  children,
  className = '',
  bleed,
}: Props) {
  return (
    <section className={`admin-card flex flex-col overflow-hidden ${className}`}>
      <header className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-ink-subtle">
              {eyebrow}
            </p>
          )}
          <h2 className="font-display text-[17px] font-semibold tracking-tight text-ink">
            {title}
          </h2>
          {description && <p className="mt-1 text-[12px] text-ink-muted">{description}</p>}
        </div>
        {action && (
          <Link
            href={action.href}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            {action.label}
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </header>
      <div className={bleed ? '' : 'px-5 pb-5'}>{children}</div>
    </section>
  );
}

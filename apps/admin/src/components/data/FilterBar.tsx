'use client';

import { useState, type ReactNode } from 'react';
import { Filter, Search, X } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { StatusBadge } from './StatusBadge';
import type { StatusDomain, StatusTone } from '@/lib/status-registry';

export type StatusTab<TId extends string = string> = {
  id: TId;
  label: string;
  count?: number;
  tone?: StatusTone;
  /** When set, the tab renders a StatusBadge on active state using this domain */
  domain?: StatusDomain;
  statusKey?: string;
};

type Props<TId extends string> = {
  /** Status tabs (e.g. "Todos · En curso · Completados · Cancelados"). Optional. */
  tabs?: StatusTab<TId>[];
  activeTab?: TId;
  onTabChange?: (id: TId) => void;

  /** Free-text search bound to an input */
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };

  /** Additional filter controls rendered inside a collapsible panel */
  children?: ReactNode;

  /** Number of active filters (excluding tab/search) — shown as a badge on the Filtros button */
  activeFilterCount?: number;

  /** Optional action slot (right side) — e.g. "Exportar CSV" */
  actions?: ReactNode;

  /** Sticky under the 64px header */
  sticky?: boolean;

  className?: string;
};

const TONE_CLASS: Record<StatusTone, string> = {
  default: 'text-ink',
  primary: 'text-primary-600 dark:text-primary-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
  info: 'text-sky-600 dark:text-sky-400',
};

export function FilterBar<TId extends string = string>({
  tabs,
  activeTab,
  onTabChange,
  search,
  children,
  activeFilterCount = 0,
  actions,
  sticky,
  className = '',
}: Props<TId>) {
  const { t } = useTranslation('admin');
  const [expanded, setExpanded] = useState(false);
  const hasChildren = Boolean(children);

  const searchPlaceholder = search?.placeholder ?? t('common.search_placeholder', { defaultValue: 'Buscar…' });
  const searchAriaLabel = search?.placeholder ?? t('common.search', { defaultValue: 'Buscar' });

  return (
    <div
      className={`
        ${sticky ? 'sticky top-16 z-20' : ''}
        rounded-2xl border border-line bg-surface-elevated/85 shadow-elev-1
        supports-[backdrop-filter]:bg-surface-elevated/70 supports-[backdrop-filter]:backdrop-blur-xl
        ${className}
      `}
    >
      {/* Top row: tabs + search + filters toggle + actions */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 md:flex-nowrap">
        {tabs && tabs.length > 0 && (
          <nav
            aria-label={t('filters.status_filters_aria', { defaultValue: 'Filtros de estado' })}
            className="-mx-1 flex flex-1 items-center gap-1 overflow-x-auto px-1"
          >
            {tabs.map((tab) => {
              const active = tab.id === activeTab;
              const toneCls = active ? TONE_CLASS[tab.tone ?? 'default'] : 'text-ink-muted';
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onTabChange?.(tab.id)}
                  aria-pressed={active}
                  className={`
                    inline-flex flex-shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-all
                    ${active
                      ? 'border-line-strong bg-surface shadow-elev-1'
                      : 'border-transparent hover:bg-surface-sunken'}
                    ${toneCls}
                  `}
                >
                  <span className="whitespace-nowrap">{tab.label}</span>
                  {typeof tab.count === 'number' && (
                    <span
                      className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
                        active ? 'bg-surface-sunken text-ink-muted' : 'bg-surface-sunken/70 text-ink-subtle'
                      }`}
                      data-tabular
                    >
                      {tab.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        )}

        {/* Search */}
        {search && (
          <div className="relative flex-1 md:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
            <input
              type="search"
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchAriaLabel}
              className="h-8 w-full rounded-full border border-line bg-surface pl-8 pr-3 text-[12px] text-ink placeholder:text-ink-subtle focus:border-primary-500 focus:outline-none"
            />
            {search.value && (
              <button
                type="button"
                onClick={() => search.onChange('')}
                aria-label={t('common.clear_search', { defaultValue: 'Limpiar búsqueda' })}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-subtle hover:text-ink"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        {/* Filters toggle */}
        {hasChildren && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors ${
              activeFilterCount > 0
                ? 'border-primary-500/40 bg-primary-500/10 text-primary-600 dark:text-primary-400'
                : 'border-line bg-surface text-ink-muted hover:text-ink'
            }`}
          >
            <Filter className="h-3.5 w-3.5" strokeWidth={2} />
            <span>{t('common.filters', { defaultValue: 'Filtros' })}</span>
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-primary-500 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
        )}

        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>

      {/* Advanced filters panel */}
      {hasChildren && expanded && (
        <div className="border-t border-line px-4 py-3 animate-fade-in">{children}</div>
      )}
    </div>
  );
}

/**
 * Build a status-tab list with counts from a row-array. Example:
 *   const tabs = buildStatusTabs('ride', rides, ['searching','in_progress','completed'])
 */
export function buildStatusTabs<T extends { status: string }>(
  _domain: StatusDomain,
  rows: T[],
  keys: (keyof typeof StatusBadge | string)[],
  labels: Record<string, string>,
) {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return keys.map((k) => ({
    id: k as string,
    label: labels[k as string] ?? String(k),
    count: counts[k as string] ?? 0,
  }));
}

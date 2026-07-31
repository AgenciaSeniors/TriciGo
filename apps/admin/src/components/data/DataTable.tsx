'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUp, ArrowDown, AlertCircle, ArrowUpDown, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from '@tricigo/i18n';
import { TableSkeleton } from './TableSkeleton';
import { DataEmptyState } from './DataEmptyState';
import { DataTablePagination, type PaginationState } from './DataTablePagination';

export type DataColumn<T> = {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sortKey?: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
  /** Below this breakpoint, column is hidden on desktop table. Rendered in card view as a label/value pair unless `hideInCard` is true. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
  /** Drop from the mobile card layout entirely */
  hideInCard?: boolean;
  /** Marks the column whose value is shown as the card title on mobile */
  primary?: boolean;
  /** Marks the column whose value is shown as the card subtitle on mobile */
  secondary?: boolean;
  /** Uses mono font and tabular-nums (IDs, prices, codes) */
  mono?: boolean;
  /** Override label used above the value in the mobile card view. Defaults to `header`. */
  cardLabel?: ReactNode;
};

export type SortState = {
  columnId: string;
  direction: 'asc' | 'desc';
};

type Action<T> = {
  label: string;
  onClick: (row: T) => void;
  tone?: 'default' | 'danger';
};

type Props<T> = {
  columns: DataColumn<T>[];
  rows: T[];
  keyField: keyof T;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;

  /** Empty state to show when rows.length === 0 and no error/loading */
  empty?: {
    icon: Parameters<typeof DataEmptyState>[0]['icon'];
    title: string;
    body?: ReactNode;
    action?: Parameters<typeof DataEmptyState>[0]['action'];
    tone?: Parameters<typeof DataEmptyState>[0]['tone'];
  };

  /** Navigation or callback when a row is clicked */
  rowHref?: (row: T) => string;
  onRowClick?: (row: T) => void;

  /** Extra actions rendered at the end of each row (desktop) and inside cards (mobile) */
  rowActions?: Action<T>[];

  /** Optional sort state (controlled) */
  sort?: SortState | null;
  onSortChange?: (next: SortState) => void;

  /** Pagination state (controlled). If omitted, pagination footer is hidden. */
  pagination?: PaginationState;
  onPaginationChange?: (next: PaginationState) => void;

  /** When true, the <thead> sticks to the top of its scroll container */
  stickyHeader?: boolean;

  /** Dense (row height ~40px) vs comfortable (~52px). Default: comfortable. */
  density?: 'comfortable' | 'dense';

  className?: string;
};

const HIDE_CLASSES: Record<NonNullable<DataColumn<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
};

function alignClass(a?: DataColumn<unknown>['align']) {
  return a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';
}

export function DataTable<T>({
  columns,
  rows,
  keyField,
  loading,
  error,
  onRetry,
  empty,
  rowHref,
  onRowClick,
  rowActions,
  sort,
  onSortChange,
  pagination,
  onPaginationChange,
  stickyHeader,
  density = 'comfortable',
  className = '',
}: Props<T>) {
  const { t } = useTranslation('admin');
  const isInteractive = Boolean(rowHref || onRowClick);
  const padY = density === 'dense' ? 'py-2' : 'py-3.5';
  const primaryCol = columns.find((c) => c.primary) ?? columns[0];
  const secondaryCol = columns.find((c) => c.secondary);

  const detailCols = columns.filter(
    (c) => !c.primary && !c.secondary && !c.hideInCard,
  );

  const renderHeader = (col: DataColumn<T>) => {
    const sortable = Boolean(col.sortKey) && Boolean(onSortChange);
    // Sort by the declared sortKey (a real row property), not the display id.
    // With col.id, a column like rides' Tarifa (id 'fare', sortKey
    // 'estimated_fare_cup') emitted a columnId that isn't a row key and the
    // consumer's `row[sort.columnId]` sort was a silent no-op.
    const sortId = col.sortKey ?? col.id;
    const active = sort?.columnId === sortId;
    const Icon = active ? (sort!.direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;

    const content = (
      <span className={`flex items-center gap-1 ${sortable ? 'cursor-pointer select-none' : ''} ${alignClass(col.align)} ${col.align === 'right' ? 'justify-end' : col.align === 'center' ? 'justify-center' : ''}`}>
        <span>{col.header}</span>
        {sortable && (
          <Icon className={`h-3 w-3 ${active ? 'text-ink' : 'text-ink-subtle'}`} strokeWidth={2} />
        )}
      </span>
    );

    if (!sortable) return content;
    return (
      <button
        type="button"
        onClick={() => {
          const next: SortState =
            active && sort?.direction === 'asc'
              ? { columnId: sortId, direction: 'desc' }
              : { columnId: sortId, direction: 'asc' };
          onSortChange!(next);
        }}
        className="inline-flex w-full"
      >
        {content}
      </button>
    );
  };

  const showTable = !loading && !error;
  const showEmpty = showTable && rows.length === 0 && !!empty;

  return (
    <div className={`admin-card flex flex-col overflow-hidden ${className}`}>
      {error && (
        <div className="flex items-start gap-3 border-b border-line bg-red-500/5 px-5 py-3">
          <AlertCircle className="mt-0.5 h-4 w-4 text-red-500" />
          <div className="flex-1">
            <p className="text-[13px] font-medium text-red-600 dark:text-red-400">
              {t('common.load_error', { defaultValue: 'No pudimos cargar los datos' })}
            </p>
            <p className="text-[11.5px] text-ink-muted">{error}</p>
          </div>
          {onRetry && (
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1 rounded-full border border-red-500/30 px-2.5 py-1 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
            >
              <RefreshCw className="h-3 w-3" />
              {t('common.retry', { defaultValue: 'Reintentar' })}
            </button>
          )}
        </div>
      )}

      {loading && (
        <div className="px-3 py-2 md:px-0">
          <TableSkeleton columns={columns} rowCount={pagination?.pageSize ? Math.min(pagination.pageSize, 8) : 6} />
        </div>
      )}

      {showEmpty && empty && (
        <div className="px-5 py-2">
          <DataEmptyState
            icon={empty.icon}
            title={empty.title}
            body={empty.body}
            action={empty.action}
            tone={empty.tone}
          />
        </div>
      )}

      {showTable && rows.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <div className="relative w-full overflow-x-auto">
              <table className="w-full border-separate border-spacing-0">
                <thead className={stickyHeader ? 'sticky top-0 z-10 bg-surface-elevated' : ''}>
                  <tr>
                    {columns.map((col) => (
                      <th
                        key={col.id}
                        className={`border-b border-line px-4 py-2.5 text-left font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle ${col.hideBelow ? HIDE_CLASSES[col.hideBelow] : ''} ${alignClass(col.align)}`}
                        style={col.width ? { width: col.width } : undefined}
                      >
                        {renderHeader(col)}
                      </th>
                    ))}
                    {rowActions && rowActions.length > 0 && (
                      <th className="w-[1%] border-b border-line px-4 py-2.5"></th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const rowKey = String(row[keyField]);
                    const baseCls = `transition-colors ${isInteractive ? 'cursor-pointer hover:bg-surface-sunken/60' : ''}`;
                    const cells = (
                      <>
                        {columns.map((col) => (
                          <td
                            key={col.id}
                            className={`
                              border-b border-line px-4 ${padY}
                              text-[13px] text-ink
                              ${col.mono ? 'font-mono tabular' : ''}
                              ${col.hideBelow ? HIDE_CLASSES[col.hideBelow] : ''}
                              ${alignClass(col.align)}
                              ${i === rows.length - 1 ? 'border-b-0' : ''}
                            `}
                          >
                            {col.cell(row)}
                          </td>
                        ))}
                        {rowActions && rowActions.length > 0 && (
                          <td className={`border-b border-line px-2 ${padY} text-right ${i === rows.length - 1 ? 'border-b-0' : ''}`}>
                            <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                              {rowActions.map((a, ai) => (
                                <button
                                  key={ai}
                                  type="button"
                                  onClick={() => a.onClick(row)}
                                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                                    a.tone === 'danger'
                                      ? 'text-red-600 hover:bg-red-500/10 dark:text-red-400'
                                      : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'
                                  }`}
                                >
                                  {a.label}
                                </button>
                              ))}
                            </div>
                          </td>
                        )}
                      </>
                    );

                    if (rowHref) {
                      return (
                        <tr
                          key={rowKey}
                          className={baseCls}
                          onClick={() => (window.location.href = rowHref(row))}
                        >
                          {cells}
                        </tr>
                      );
                    }
                    return (
                      <tr key={rowKey} className={baseCls} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                        {cells}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <ul className="divide-y divide-line md:hidden">
            {rows.map((row) => {
              const rowKey = String(row[keyField]);
              const cardBody = (
                <div className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {primaryCol && (
                        <div className={`text-[14px] font-medium text-ink ${primaryCol.mono ? 'font-mono tabular' : ''}`}>
                          {primaryCol.cell(row)}
                        </div>
                      )}
                      {secondaryCol && (
                        <div className={`mt-0.5 text-[11.5px] text-ink-muted ${secondaryCol.mono ? 'font-mono tabular' : ''}`}>
                          {secondaryCol.cell(row)}
                        </div>
                      )}
                    </div>
                  </div>
                  {detailCols.length > 0 && (
                    <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11.5px]">
                      {detailCols.map((col) => (
                        <div key={col.id} className="flex flex-col">
                          <dt className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-subtle">
                            {col.cardLabel ?? col.header}
                          </dt>
                          <dd className={`text-ink ${col.mono ? 'font-mono tabular' : ''}`}>
                            {col.cell(row)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {rowActions && rowActions.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-2 pt-1">
                      {rowActions.map((a, ai) => (
                        <button
                          key={ai}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            a.onClick(row);
                          }}
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                            a.tone === 'danger'
                              ? 'border-red-500/30 text-red-600 dark:text-red-400'
                              : 'border-line text-ink-muted hover:text-ink'
                          }`}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );

              if (rowHref) {
                return (
                  <li key={rowKey}>
                    <Link
                      href={rowHref(row)}
                      className="block transition-colors hover:bg-surface-sunken/60 focus-visible:bg-surface-sunken"
                    >
                      {cardBody}
                    </Link>
                  </li>
                );
              }
              if (onRowClick) {
                return (
                  <li key={rowKey}>
                    <button
                      type="button"
                      onClick={() => onRowClick(row)}
                      className="block w-full text-left transition-colors hover:bg-surface-sunken/60"
                    >
                      {cardBody}
                    </button>
                  </li>
                );
              }
              return <li key={rowKey}>{cardBody}</li>;
            })}
          </ul>
        </>
      )}

      {pagination && onPaginationChange && !error && rows.length > 0 && (
        <DataTablePagination state={pagination} onChange={onPaginationChange} />
      )}
    </div>
  );
}

/** Convenience empty-state defaults for common scenarios */
export const DataTableFallbacks = {
  noResults: {
    icon: Search,
    title: 'Sin resultados',
    body: 'Prueba ajustar los filtros o limpiar la búsqueda.',
  },
};

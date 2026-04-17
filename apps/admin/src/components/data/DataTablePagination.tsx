'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

export type PaginationState = {
  page: number; // zero-indexed
  pageSize: number;
  /** Total rows across pages (if known). If omitted, next-page becomes
   *  "keep going while current page is full". */
  total?: number;
  /** Whether the current page has a full batch — used to allow next-page
   *  when `total` is unknown. */
  hasMore?: boolean;
};

type Props = {
  state: PaginationState;
  onChange: (next: PaginationState) => void;
  /** Shown above the controls, e.g. "6 viajes". Optional. */
  summaryLabel?: (args: { from: number; to: number; total?: number }) => string;
  pageSizes?: number[];
};

const DEFAULT_SIZES = [10, 25, 50, 100];

export function DataTablePagination({
  state,
  onChange,
  summaryLabel,
  pageSizes = DEFAULT_SIZES,
}: Props) {
  const { page, pageSize, total, hasMore } = state;
  const from = page * pageSize + 1;
  const to = total ? Math.min(total, (page + 1) * pageSize) : (page + 1) * pageSize;
  const totalPages = total ? Math.max(1, Math.ceil(total / pageSize)) : undefined;

  const canPrev = page > 0;
  const canNext = total !== undefined ? page < (totalPages ?? 1) - 1 : Boolean(hasMore);

  const defaultSummary = () => {
    if (total === 0) return 'Sin resultados';
    if (total !== undefined) return `${from}–${to} de ${total}`;
    return `Página ${page + 1}`;
  };

  const summary = summaryLabel
    ? summaryLabel({ from, to, total })
    : defaultSummary();

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-[12px] text-ink-muted">
      <div className="flex items-center gap-3">
        <span className="font-mono tabular" data-tabular>
          {summary}
        </span>
        {total !== 0 && (
          <label className="hidden items-center gap-1.5 sm:inline-flex">
            <span className="text-ink-subtle">Por página</span>
            <select
              value={pageSize}
              onChange={(e) => onChange({ ...state, pageSize: Number(e.target.value), page: 0 })}
              className="rounded-md border border-line bg-surface px-1.5 py-0.5 text-[12px] text-ink focus:border-primary-500 focus:outline-none"
            >
              {pageSizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => canPrev && onChange({ ...state, page: page - 1 })}
          disabled={!canPrev}
          aria-label="Página anterior"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        {totalPages !== undefined ? (
          <span className="min-w-[80px] px-2 text-center font-mono text-[11px] text-ink-muted" data-tabular>
            {page + 1} / {totalPages}
          </span>
        ) : (
          <span className="min-w-[60px] px-2 text-center font-mono text-[11px] text-ink-muted" data-tabular>
            {page + 1}
          </span>
        )}
        <button
          type="button"
          onClick={() => canNext && onChange({ ...state, page: page + 1 })}
          disabled={!canNext}
          aria-label="Página siguiente"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

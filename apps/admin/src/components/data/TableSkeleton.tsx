'use client';

import type { DataColumn } from './DataTable';

type Props<T> = {
  columns: DataColumn<T>[];
  rowCount?: number;
};

/**
 * Column-aware skeleton used while a DataTable is loading. Matches the
 * actual table shape (widths + hide-below breakpoints) so the hand-off
 * to real data is visually stable.
 */
export function TableSkeleton<T>({ columns, rowCount = 6 }: Props<T>) {
  return (
    <div role="status" aria-label="Cargando datos">
      <div className="hidden md:block">
        <table className="w-full">
          <tbody>
            {Array.from({ length: rowCount }).map((_, r) => (
              <tr key={r} className="border-t border-line first:border-t-0">
                {columns.map((col, c) => {
                  const hide =
                    col.hideBelow === 'lg'
                      ? 'hidden lg:table-cell'
                      : col.hideBelow === 'md'
                        ? 'hidden md:table-cell'
                        : col.hideBelow === 'sm'
                          ? 'hidden sm:table-cell'
                          : '';
                  const widthCls = col.primary ? 'w-[60%]' : c === columns.length - 1 ? 'w-[15%]' : 'w-[20%]';
                  return (
                    <td key={col.id} className={`px-4 py-3.5 ${hide}`}>
                      <div className={`h-3 ${widthCls} animate-pulse rounded bg-surface-sunken`} />
                      {col.primary && (
                        <div className="mt-1.5 h-2.5 w-[40%] animate-pulse rounded bg-surface-sunken/70" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-3 md:hidden">
        {Array.from({ length: rowCount }).map((_, r) => (
          <div key={r} className="rounded-xl border border-line bg-surface-elevated p-4">
            <div className="h-3.5 w-[70%] animate-pulse rounded bg-surface-sunken" />
            <div className="mt-2 h-2.5 w-[50%] animate-pulse rounded bg-surface-sunken/70" />
            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="h-2.5 w-[60%] animate-pulse rounded bg-surface-sunken/60" />
              <div className="h-2.5 w-[40%] animate-pulse rounded bg-surface-sunken/60" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

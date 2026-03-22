'use client';
import { useState, useMemo } from 'react';

type SortDirection = 'asc' | 'desc';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useSortableTable<T extends Record<string, any>>(
  data: T[],
  defaultSortKey?: keyof T,
  defaultDirection: SortDirection = 'desc',
) {
  const [sortKey, setSortKey] = useState<keyof T | null>(defaultSortKey ?? null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(defaultDirection);

  const sortedData = useMemo(() => {
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      let comparison = 0;
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        comparison = aVal.localeCompare(bVal);
      } else if (typeof aVal === 'number' && typeof bVal === 'number') {
        comparison = aVal - bVal;
      } else {
        comparison = String(aVal).localeCompare(String(bVal));
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [data, sortKey, sortDirection]);

  const toggleSort = (key: keyof T) => {
    if (sortKey === key) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('desc');
    }
  };

  const getSortIndicator = (key: keyof T) => {
    if (sortKey !== key) return ' ↕';
    return sortDirection === 'asc' ? ' ▲' : ' ▼';
  };

  return { sortedData, toggleSort, getSortIndicator, sortKey, sortDirection };
}

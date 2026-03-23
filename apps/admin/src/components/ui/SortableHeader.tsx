'use client';
import React from 'react';

interface SortableHeaderProps {
  label: string;
  sortKey: string;
  currentSortKey: string | null;
  sortDirection: 'asc' | 'desc';
  onSort: (key: string) => void;
  className?: string;
}

export function SortableHeader({ label, sortKey, currentSortKey, sortDirection, onSort, className = '' }: SortableHeaderProps) {
  const isActive = currentSortKey === sortKey;
  return (
    <th
      className={`cursor-pointer select-none hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors ${className}`}
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(sortKey); } }}
      role="button"
      tabIndex={0}
      aria-sort={isActive ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}
      aria-label={`Sort by ${label}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-xs ${isActive ? 'text-primary-500' : 'text-neutral-400'}`}>
          {isActive ? (sortDirection === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </span>
    </th>
  );
}

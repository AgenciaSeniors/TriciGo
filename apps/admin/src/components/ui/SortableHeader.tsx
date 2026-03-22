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
      className={`cursor-pointer select-none hover:bg-neutral-100 transition-colors ${className}`}
      onClick={() => onSort(sortKey)}
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

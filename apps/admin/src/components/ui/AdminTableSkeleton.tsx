'use client';
import React from 'react';

interface AdminTableSkeletonProps {
  rows?: number;
  columns?: number;
}

export function AdminTableSkeleton({ rows = 5, columns = 4 }: AdminTableSkeletonProps) {
  return (
    <div className="animate-pulse">
      {/* Header */}
      <div className="flex gap-4 mb-3 px-4 py-3 bg-neutral-100 dark:bg-neutral-700 rounded-t-lg">
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} className="h-4 bg-neutral-200 dark:bg-neutral-600 rounded flex-1" />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 px-4 py-4 border-b border-neutral-100 dark:border-neutral-700">
          {Array.from({ length: columns }).map((_, c) => (
            <div key={c} className={`h-3 bg-neutral-100 dark:bg-neutral-700 rounded flex-1 ${c === 0 ? 'max-w-[200px]' : ''}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

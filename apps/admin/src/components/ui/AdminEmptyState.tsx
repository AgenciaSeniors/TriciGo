'use client';
import React from 'react';
import { Package } from 'lucide-react';

interface AdminEmptyStateProps {
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  /** Alias for description — use either prop */
  message?: string;
  action?: { label: string; onClick: () => void };
}

export function AdminEmptyState({ icon, title, description, message, action }: AdminEmptyStateProps) {
  const renderedIcon = icon ?? <Package className="w-10 h-10 text-neutral-300 dark:text-neutral-500" />;
  const desc = description ?? message;

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="mb-3">{renderedIcon}</div>
      {title && <h3 className="text-lg font-semibold text-neutral-700 dark:text-neutral-300 mb-1">{title}</h3>}
      {desc && <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">{desc}</p>}
      {action && (
        <button onClick={action.onClick} className="text-sm bg-primary-500 hover:bg-primary-600 text-white px-4 py-2 rounded-lg font-medium transition-colors">
          {action.label}
        </button>
      )}
    </div>
  );
}

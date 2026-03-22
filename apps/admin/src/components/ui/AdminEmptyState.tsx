'use client';
import React from 'react';

interface AdminEmptyStateProps {
  icon?: string;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function AdminEmptyState({ icon = '📋', title, description, action }: AdminEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <span className="text-4xl mb-3">{icon}</span>
      <h3 className="text-lg font-semibold text-neutral-700 dark:text-neutral-300 mb-1">{title}</h3>
      {description && <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">{description}</p>}
      {action && (
        <button onClick={action.onClick} className="text-sm bg-primary-500 hover:bg-primary-600 text-white px-4 py-2 rounded-lg font-medium transition-colors">
          {action.label}
        </button>
      )}
    </div>
  );
}

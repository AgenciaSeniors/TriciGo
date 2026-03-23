'use client';
import React from 'react';

interface AdminErrorBannerProps {
  message: string;
  retryLabel?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export function AdminErrorBanner({ message, retryLabel = 'Reintentar', onRetry, onDismiss }: AdminErrorBannerProps) {
  return (
    <div role="alert" className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 mb-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-red-500 dark:text-red-400 text-lg">&#9888;&#65039;</span>
        <p className="text-red-700 dark:text-red-400 text-sm">{message}</p>
      </div>
      <div className="flex gap-2">
        {onRetry && (
          <button onClick={onRetry} aria-label={retryLabel} className="text-sm bg-red-100 dark:bg-red-800/40 hover:bg-red-200 dark:hover:bg-red-800/60 text-red-700 dark:text-red-300 px-3 py-1.5 rounded-md font-medium transition-colors">
            {retryLabel}
          </button>
        )}
        {onDismiss && (
          <button onClick={onDismiss} aria-label="Dismiss error" className="text-red-400 dark:text-red-500 hover:text-red-600 dark:hover:text-red-300 text-lg leading-none">&times;</button>
        )}
      </div>
    </div>
  );
}

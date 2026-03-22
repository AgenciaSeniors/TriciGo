'use client';
import React from 'react';

interface AdminErrorBannerProps {
  message: string;
  onRetry?: () => void;
  onDismiss?: () => void;
}

export function AdminErrorBanner({ message, onRetry, onDismiss }: AdminErrorBannerProps) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-red-500 text-lg">&#9888;&#65039;</span>
        <p className="text-red-700 text-sm">{message}</p>
      </div>
      <div className="flex gap-2">
        {onRetry && (
          <button onClick={onRetry} className="text-sm bg-red-100 hover:bg-red-200 text-red-700 px-3 py-1.5 rounded-md font-medium transition-colors">
            Reintentar
          </button>
        )}
        {onDismiss && (
          <button onClick={onDismiss} className="text-red-400 hover:text-red-600 text-lg leading-none">&times;</button>
        )}
      </div>
    </div>
  );
}

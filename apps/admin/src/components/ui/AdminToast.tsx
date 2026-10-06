'use client';
import React, { createContext, useContext, useState, useCallback } from 'react';

type ToastType = 'success' | 'error' | 'warning';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextType {
  showToast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextType>({ showToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function AdminToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((type: ToastType, message: string) => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  }, []);

  const colors = {
    success: 'bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-500/30 text-green-700 dark:text-green-400',
    error: 'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-400',
    warning: 'bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-400',
  };
  const icons = { success: '\u2713', error: '\u2715', warning: '\u26A0' };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2" style={{ maxWidth: 400 }}>
        {toasts.map(t => (
          <div key={t.id} role="alert" aria-live="assertive" className={`${colors[t.type]} border rounded-lg px-4 py-3 shadow-lg flex items-center gap-2 text-sm animate-in slide-in-from-right`}>
            <span className="font-bold">{icons[t.type]}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

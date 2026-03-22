/**
 * Centralized logger for TriciGo.
 * Provides structured logging with context for debugging production issues.
 * Sentry integration is handled by each app's error boundary — this logger
 * ensures all errors have consistent context for Sentry to capture.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogContext = Record<string, string | number | boolean | null | undefined>;

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: LogContext;
  timestamp: string;
  service?: string;
}

let globalContext: LogContext = {};

/**
 * Set global context that's included in every log entry.
 * Call once at app startup with user/session info.
 */
export function setLogContext(ctx: LogContext): void {
  globalContext = { ...globalContext, ...ctx };
}

/**
 * Clear global context (call on logout).
 */
export function clearLogContext(): void {
  globalContext = {};
}

function log(level: LogLevel, message: string, context?: LogContext): void {
  const entry: LogEntry = {
    level,
    message,
    context: { ...globalContext, ...context },
    timestamp: new Date().toISOString(),
  };

  switch (level) {
    case 'debug':
      if (__DEV__) console.debug(`[${entry.timestamp}] ${message}`, entry.context);
      break;
    case 'info':
      console.log(`[${entry.timestamp}] ${message}`, entry.context);
      break;
    case 'warn':
      console.warn(`[${entry.timestamp}] ${message}`, entry.context);
      break;
    case 'error':
      // Errors are always logged — Sentry captures console.error in production
      console.error(`[${entry.timestamp}] ${message}`, entry.context);
      break;
  }
}

// Declare __DEV__ for TypeScript
declare const __DEV__: boolean | undefined;

export const logger = {
  debug: (message: string, context?: LogContext) => log('debug', message, context),
  info: (message: string, context?: LogContext) => log('info', message, context),
  warn: (message: string, context?: LogContext) => log('warn', message, context),
  error: (message: string, context?: LogContext) => log('error', message, context),
  setContext: setLogContext,
  clearContext: clearLogContext,
};

import { useEffect, useState } from 'react';

/**
 * Returns a debounced copy of `value` that only updates after `delayMs` have
 * elapsed without further changes. Use it to feed a fast-changing input (e.g.
 * a search box bound on every keystroke) into an expensive effect (a fetch)
 * without firing once per character.
 *
 *   const search = useDebouncedValue(searchInput, 300);
 *   // `search` lags `searchInput` by 300ms of idle typing
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}

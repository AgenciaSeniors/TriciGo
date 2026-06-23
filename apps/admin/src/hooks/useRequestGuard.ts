import { useCallback, useRef } from 'react';

/**
 * Guards against out-of-order async responses. Each call to the returned
 * `begin()` bumps an internal generation counter and hands back an
 * `isLatest()` closure that is only true while that call remains the most
 * recent one. Apply state from an async response only when `isLatest()` is
 * still true, so a slow earlier request can't clobber a newer one.
 *
 *   const begin = useRequestGuard();
 *   const fetchRows = useCallback(async () => {
 *     const isLatest = begin();
 *     const data = await service.get(...);
 *     if (!isLatest()) return;   // a newer fetch already started — drop this
 *     setRows(data);
 *   }, [begin]);
 */
export function useRequestGuard(): () => () => boolean {
  const genRef = useRef(0);
  return useCallback(() => {
    const myGen = ++genRef.current;
    return () => myGen === genRef.current;
  }, []);
}

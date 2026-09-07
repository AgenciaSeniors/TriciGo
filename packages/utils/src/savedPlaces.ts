// ============================================================
// TriciGo — The rider's fixed places: Casa and Trabajo.
//
// Saved places used to be a flat list where "home" meant "a label that
// contains the word casa". `kind` makes it explicit; the label heuristic
// stays as a fallback for rows saved before the field existed.
// ============================================================

import { stripAccents } from './fuzzyMatch';

export type FixedPlaceKind = 'home' | 'work';

export interface FixedPlaces<T> {
  home?: T;
  work?: T;
  /** Everything that is not the home or the work slot, in original order. */
  others: T[];
}

function kindOf(place: { label: string; kind?: string | null }): FixedPlaceKind | null {
  if (place.kind === 'home' || place.kind === 'work') return place.kind;
  if (place.kind === 'other') return null;
  const label = stripAccents((place.label ?? '').toLowerCase().trim());
  if (/\bcasa\b/.test(label) || label === 'home') return 'home';
  if (/\btrabajo\b/.test(label) || /\boficina\b/.test(label) || label === 'work') return 'work';
  return null;
}

/**
 * Split saved places into the two fixed slots and the rest. An explicit
 * `kind` wins; legacy rows fall back to the label. The first match keeps a
 * slot — duplicates go to `others` so nothing the rider saved disappears.
 */
export function resolveFixedPlaces<T extends { label: string; kind?: string | null }>(
  saved: ReadonlyArray<T>,
): FixedPlaces<T> {
  let home: T | undefined;
  let work: T | undefined;
  const others: T[] = [];
  for (const place of saved) {
    const kind = kindOf(place);
    if (kind === 'home' && !home) home = place;
    else if (kind === 'work' && !work) work = place;
    else others.push(place);
  }
  return { home, work, others };
}

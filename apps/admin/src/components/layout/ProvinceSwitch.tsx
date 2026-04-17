'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, MapPin } from 'lucide-react';
import { CUBA_PROVINCES } from '@tricigo/utils';

type Scope = {
  value: string;
  label: string;
  /** Short contextual hint shown under the name */
  hint?: string;
};

const ALL_CUBA: Scope = {
  value: 'all',
  label: 'Todo Cuba',
  hint: '16 provincias · 168 municipios',
};

const REGION_HINTS: Record<string, string> = {
  pinar_del_rio: 'Occidente',
  artemisa: 'Occidente',
  la_habana: 'Capital',
  mayabeque: 'Occidente',
  matanzas: 'Occidente',
  villa_clara: 'Centro',
  cienfuegos: 'Centro',
  sancti_spiritus: 'Centro',
  ciego_de_avila: 'Centro',
  camaguey: 'Centro',
  las_tunas: 'Oriente',
  holguin: 'Oriente',
  granma: 'Oriente',
  santiago_de_cuba: 'Oriente',
  guantanamo: 'Oriente',
  isla_de_la_juventud: 'Municipio especial',
};

const SCOPES: Scope[] = [
  ALL_CUBA,
  ...CUBA_PROVINCES.map((p) => ({
    value: p.value,
    label: p.label,
    hint: REGION_HINTS[p.value],
  })),
];

const STORAGE_KEY = 'admin-province-scope';

export function ProvinceSwitch() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Scope>(ALL_CUBA);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const found = SCOPES.find((s) => s.value === saved);
      if (found) setSelected(found);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const choose = (s: Scope) => {
    setSelected(s);
    window.localStorage.setItem(STORAGE_KEY, s.value);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink transition-all hover:border-line-strong hover:bg-surface-sunken"
      >
        <MapPin className="h-3.5 w-3.5 text-primary-500" strokeWidth={2} />
        <span className="hidden max-w-[120px] truncate sm:inline">{selected.label}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-ink-subtle transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-50 mt-2 w-72 origin-top-right overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-elev-3 animate-fade-in"
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-subtle">
              Cuba · 16 provincias
            </p>
            <p className="mt-0.5 text-[11px] text-ink-muted">Filtrá el panel por alcance geográfico.</p>
          </div>
          <ul className="max-h-[50vh] overflow-y-auto py-1">
            {SCOPES.map((s) => {
              const active = s.value === selected.value;
              return (
                <li key={s.value}>
                  <button
                    onClick={() => choose(s)}
                    className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${
                      active ? 'bg-primary-500/10' : 'hover:bg-surface-sunken'
                    }`}
                    role="option"
                    aria-selected={active}
                  >
                    <span
                      className={`mt-0.5 h-2 w-2 flex-shrink-0 rounded-full ${
                        s.value === 'all' ? 'bg-primary-500' : 'bg-ink-subtle'
                      }`}
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span
                        className={`truncate text-[13px] font-medium ${
                          active ? 'text-primary-600 dark:text-primary-400' : 'text-ink'
                        }`}
                      >
                        {s.label}
                      </span>
                      {s.hint && (
                        <span className="truncate text-[10.5px] text-ink-muted">{s.hint}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

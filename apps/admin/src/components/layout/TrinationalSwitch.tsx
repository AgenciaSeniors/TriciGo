'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Globe2 } from 'lucide-react';

type Country = {
  code: 'BR' | 'PY' | 'AR' | 'ALL';
  label: string;
  flag: string;
  hint: string;
  color: string;
};

const COUNTRIES = [
  { code: 'ALL', label: 'Trinacional', flag: '🌎', hint: 'Todos los países', color: 'text-primary-500' },
  { code: 'BR', label: 'Brasil', flag: '🇧🇷', hint: 'Foz do Iguaçu · BRL · UTC−3', color: 'text-flag-br' },
  { code: 'PY', label: 'Paraguay', flag: '🇵🇾', hint: 'Ciudad del Este · PYG · UTC−4', color: 'text-flag-py' },
  { code: 'AR', label: 'Argentina', flag: '🇦🇷', hint: 'Puerto Iguazú · ARS · UTC−3', color: 'text-flag-ar' },
] as const satisfies readonly Country[];

const STORAGE_KEY = 'admin-country-scope';

export function TrinationalSwitch() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Country>(COUNTRIES[0] as Country);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const found = COUNTRIES.find((c) => c.code === saved);
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

  const choose = (c: Country) => {
    setSelected(c);
    window.localStorage.setItem(STORAGE_KEY, c.code);
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
        <span aria-hidden="true" className="text-sm leading-none">{selected.flag}</span>
        <span className="hidden sm:inline">{selected.label}</span>
        <Globe2 className="h-3.5 w-3.5 text-ink-muted sm:hidden" />
        <ChevronDown className={`h-3.5 w-3.5 text-ink-subtle transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-50 mt-2 w-64 origin-top-right overflow-hidden rounded-xl border border-line bg-surface-elevated shadow-elev-3 animate-fade-in"
        >
          <div className="border-b border-line px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-subtle">
              Tríplice Fronteira
            </p>
          </div>
          <ul className="py-1">
            {COUNTRIES.map((c) => {
              const active = c.code === selected.code;
              return (
                <li key={c.code}>
                  <button
                    onClick={() => choose(c)}
                    className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                      active ? 'bg-primary-500/10' : 'hover:bg-surface-sunken'
                    }`}
                    role="option"
                    aria-selected={active}
                  >
                    <span aria-hidden="true" className="text-lg leading-none">{c.flag}</span>
                    <span className="flex flex-col">
                      <span className={`text-sm font-medium ${active ? 'text-primary-600 dark:text-primary-400' : 'text-ink'}`}>
                        {c.label}
                      </span>
                      <span className="text-[11px] text-ink-muted">{c.hint}</span>
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

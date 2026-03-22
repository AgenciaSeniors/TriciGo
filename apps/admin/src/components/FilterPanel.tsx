'use client';

import { useState } from 'react';

export type FilterFieldType = 'text' | 'select' | 'date';

export interface FilterField {
  key: string;
  label: string;
  type: FilterFieldType;
  placeholder?: string;
  options?: { label: string; value: string }[];
}

interface FilterPanelProps {
  fields: FilterField[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onClear: () => void;
  clearLabel: string;
  toggleLabel?: string;
}

export function FilterPanel({
  fields,
  values,
  onChange,
  onClear,
  clearLabel,
  toggleLabel = 'Filters',
}: FilterPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const activeCount = Object.values(values).filter(Boolean).length;

  return (
    <div className="mb-6">
      {/* Toggle button */}
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-label={toggleLabel}
        aria-expanded={expanded}
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-white border border-neutral-200 hover:border-neutral-300 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
        </svg>
        {toggleLabel}
        {activeCount > 0 && (
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary-500 text-white text-xs">
            {activeCount}
          </span>
        )}
      </button>

      {/* Expanded filter panel */}
      {expanded && (
        <div className="mt-3 p-4 bg-white rounded-xl border border-neutral-200 shadow-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {fields.map((field) => (
              <div key={field.key}>
                <label className="block text-xs font-medium text-neutral-500 mb-1">
                  {field.label}
                </label>
                {field.type === 'select' ? (
                  <select
                    value={values[field.key] ?? ''}
                    onChange={(e) => onChange(field.key, e.target.value)}
                    aria-label={field.label}
                    className="w-full px-3 py-2 rounded-lg border border-neutral-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                  >
                    <option value="">{field.placeholder ?? '—'}</option>
                    {field.options?.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : field.type === 'date' ? (
                  <input
                    type="date"
                    value={values[field.key] ?? ''}
                    onChange={(e) => onChange(field.key, e.target.value)}
                    aria-label={field.label}
                    className="w-full px-3 py-2 rounded-lg border border-neutral-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                  />
                ) : (
                  <input
                    type="text"
                    value={values[field.key] ?? ''}
                    onChange={(e) => onChange(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    aria-label={field.label}
                    className="w-full px-3 py-2 rounded-lg border border-neutral-200 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
                  />
                )}
              </div>
            ))}
          </div>

          {/* Active filter chips + clear */}
          {activeCount > 0 && (
            <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-neutral-100">
              {fields
                .filter((f) => values[f.key])
                .map((f) => {
                  const displayValue =
                    f.type === 'select'
                      ? f.options?.find((o) => o.value === values[f.key])?.label ?? values[f.key]
                      : values[f.key];
                  return (
                    <span
                      key={f.key}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary-50 text-primary-700 text-xs font-medium"
                    >
                      {f.label}: {displayValue}
                      <button
                        onClick={() => onChange(f.key, '')}
                        className="ml-0.5 hover:text-primary-900"
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              <button
                onClick={onClear}
                className="text-xs text-neutral-500 hover:text-neutral-700 underline ml-2"
              >
                {clearLabel}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

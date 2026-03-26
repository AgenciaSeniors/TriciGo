'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from '@tricigo/i18n';

interface AddressResult {
  address: string;
  latitude: number;
  longitude: number;
  place_name: string;
}

interface AddressAutocompleteProps {
  label?: string;
  placeholder?: string;
  value?: string;
  onSelect: (result: AddressResult) => void;
  mapboxToken: string;
}

export function AddressAutocomplete({ label, placeholder, value, onSelect, mapboxToken }: AddressAutocompleteProps) {
  const { t } = useTranslation('web');
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState<AddressResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropdownVisible, setDropdownVisible] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useRef(`address-listbox-${Math.random().toString(36).slice(2, 9)}`).current;

  // Update query when value prop changes
  useEffect(() => {
    if (value !== undefined) setQuery(value);
  }, [value]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Animate dropdown open/close
  useEffect(() => {
    if (isOpen) {
      // Trigger opacity transition on next frame
      requestAnimationFrame(() => setDropdownVisible(true));
    } else {
      setDropdownVisible(false);
    }
  }, [isOpen]);

  // Scroll active item into view
  useEffect(() => {
    if (activeIndex >= 0 && listboxRef.current) {
      const item = listboxRef.current.children[activeIndex] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const search = useCallback(async (q: string) => {
    if (q.length < 2) { setResults([]); setIsOpen(false); return; }
    setLoading(true);
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&country=cu&language=es&limit=5&types=address,poi,place,neighborhood,locality`;
      const res = await fetch(url);
      const data = await res.json();
      const items: AddressResult[] = (data.features || []).map((f: any) => {
        // Extract neighborhood/locality from context for Cuban-style display
        const context = f.context || [];
        const neighborhood = context.find((c: any) => c.id?.startsWith('neighborhood'))?.text;
        const locality = context.find((c: any) => c.id?.startsWith('locality'))?.text;
        const place = context.find((c: any) => c.id?.startsWith('place'))?.text;
        const area = neighborhood || locality || place || '';

        // Build Cuban-style address: "Street, Neighborhood"
        const streetPart = f.text || '';
        const displayAddress = area && area !== streetPart
          ? `${streetPart}, ${area}`
          : f.place_name;

        return {
          address: f.place_name,
          latitude: f.center[1],
          longitude: f.center[0],
          place_name: displayAddress,
        };
      });
      setResults(items);
      setIsOpen(true);
      setActiveIndex(-1);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [mapboxToken]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.length === 0) {
      setResults([]);
      setIsOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => search(val), 300);
  }

  function handleSelect(result: AddressResult) {
    setQuery(result.address);
    setIsOpen(false);
    setActiveIndex(-1);
    onSelect(result);
  }

  function handleClear() {
    setQuery('');
    setResults([]);
    setIsOpen(false);
    setActiveIndex(-1);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!isOpen) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) => (prev < results.length - 1 ? prev + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : results.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < results.length) {
          handleSelect(results[activeIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setActiveIndex(-1);
        break;
    }
  }

  const showNoResults = query.length >= 2 && !loading && results.length === 0 && isOpen;
  const showDropdown = isOpen && (results.length > 0 || showNoResults);
  const activeDescendant = activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;

  return (
    <div
      ref={containerRef}
      role="combobox"
      aria-expanded={showDropdown}
      aria-haspopup="listbox"
      aria-owns={listId}
      style={{ position: 'relative' }}
    >
      {label && (
        <label
          style={{
            display: 'block',
            marginBottom: '0.25rem',
            fontSize: '0.85rem',
            fontWeight: 600,
            color: 'var(--text-secondary)',
          }}
        >
          {label}
        </label>
      )}

      {/* Input wrapper */}
      <div style={{ position: 'relative' }}>
        {/* Search icon */}
        <div
          style={{
            position: 'absolute',
            left: '12px',
            top: '50%',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            color: 'var(--text-tertiary)',
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>

        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => {
            if (results.length > 0 || (query.length >= 2 && !loading && results.length === 0)) {
              setIsOpen(true);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || t('web.address_placeholder', { defaultValue: 'Buscar direccion...' })}
          aria-label={label || t('web.address_placeholder', { defaultValue: 'Buscar direccion...' })}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={activeDescendant}
          style={{
            width: '100%',
            height: 48,
            paddingLeft: 40,
            paddingRight: loading || query ? 72 : 12,
            paddingTop: 0,
            paddingBottom: 0,
            borderRadius: showDropdown ? '12px 12px 0 0' : 12,
            border: '1px solid var(--border)',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            fontSize: '0.9rem',
            boxSizing: 'border-box',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            outline: 'none',
            transition: 'border-radius 0.15s ease',
          }}
        />

        {/* Right side: spinner + clear button */}
        <div
          style={{
            position: 'absolute',
            right: '8px',
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          {/* Loading spinner */}
          {loading && (
            <div
              style={{
                width: 18,
                height: 18,
                border: '2px solid var(--border)',
                borderTopColor: 'var(--primary)',
                borderRadius: '50%',
                animation: 'address-spin 0.6s linear infinite',
              }}
            />
          )}

          {/* Clear button */}
          {query.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: '50%',
                border: 'none',
                background: 'var(--border-light)',
                cursor: 'pointer',
                color: 'var(--text-tertiary)',
                padding: 0,
                transition: 'background 0.15s',
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = 'var(--border)')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'var(--border-light)')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <ul
          id={listId}
          ref={listboxRef}
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            margin: 0,
            padding: 0,
            listStyle: 'none',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderTop: 'none',
            borderRadius: '0 0 12px 12px',
            zIndex: 100,
            maxHeight: 260,
            overflowY: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            opacity: dropdownVisible ? 1 : 0,
            transition: 'opacity 0.15s ease',
          }}
        >
          {results.length > 0 ? (
            results.map((r, i) => (
              <li
                key={i}
                id={`${listId}-option-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onClick={() => handleSelect(r)}
                onMouseEnter={() => setActiveIndex(i)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.6rem',
                  padding: '0.65rem 0.75rem',
                  minHeight: 48,
                  cursor: 'pointer',
                  background: i === activeIndex ? 'rgba(var(--primary-rgb, 255,140,0), 0.08)' : 'transparent',
                  borderBottom: i < results.length - 1 ? '1px solid var(--border-light)' : 'none',
                  transition: 'background 0.1s ease',
                  boxSizing: 'border-box',
                }}
              >
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: '1.1rem',
                    lineHeight: '1.4',
                    marginTop: '0.05rem',
                  }}
                  aria-hidden="true"
                >
                  📍
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 500,
                      fontSize: '0.88rem',
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.place_name}
                  </div>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--text-tertiary)',
                      marginTop: '0.1rem',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.address}
                  </div>
                </div>
              </li>
            ))
          ) : (
            <li
              style={{
                padding: '1rem 0.75rem',
                textAlign: 'center',
                fontSize: '0.85rem',
                color: 'var(--text-tertiary)',
              }}
            >
              {t('web.address_no_results', { defaultValue: 'No se encontraron direcciones' })}
            </li>
          )}
        </ul>
      )}

      {/* CSS spinner animation */}
      <style>{`
        @keyframes address-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

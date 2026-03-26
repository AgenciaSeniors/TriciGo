'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

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
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState<AddressResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const search = useCallback(async (q: string) => {
    if (q.length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&country=cu&language=es&limit=5&types=address,poi,place,neighborhood,locality`;
      const res = await fetch(url);
      const data = await res.json();
      const items: AddressResult[] = (data.features || []).map((f: any) => ({
        address: f.place_name,
        latitude: f.center[1],
        longitude: f.center[0],
        place_name: f.text,
      }));
      setResults(items);
      setIsOpen(items.length > 0);
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
    debounceRef.current = setTimeout(() => search(val), 300);
  }

  function handleSelect(result: AddressResult) {
    setQuery(result.address);
    setIsOpen(false);
    onSelect(result);
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {label && <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</label>}
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => results.length > 0 && setIsOpen(true)}
        placeholder={placeholder || 'Buscar dirección...'}
        style={{
          width: '100%',
          padding: '0.75rem',
          borderRadius: '0.5rem',
          border: '1px solid var(--border)',
          background: 'var(--bg-card)',
          color: 'var(--text-primary)',
          fontSize: '0.9rem',
        }}
      />
      {loading && (
        <div style={{ position: 'absolute', right: '0.75rem', top: label ? '2.25rem' : '0.75rem', fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>...</div>
      )}
      {isOpen && results.length > 0 && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: '0 0 0.5rem 0.5rem',
          zIndex: 100,
          maxHeight: '200px',
          overflowY: 'auto',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => handleSelect(r)}
              style={{
                display: 'block',
                width: '100%',
                padding: '0.6rem 0.75rem',
                border: 'none',
                background: 'none',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: '0.85rem',
                color: 'var(--text-primary)',
                borderBottom: i < results.length - 1 ? '1px solid var(--border-light)' : 'none',
              }}
              onMouseOver={(e) => (e.currentTarget.style.background = 'var(--bg-page)')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'none')}
            >
              <div style={{ fontWeight: 500 }}>{r.place_name}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.15rem' }}>{r.address}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

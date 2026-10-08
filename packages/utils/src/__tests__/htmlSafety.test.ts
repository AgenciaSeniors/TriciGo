import { describe, it, expect } from 'vitest';
import { escapeHtml, serializeJsonLd, safeInternalPath } from '../htmlSafety';

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<img src=x onerror="a('b')"> & co`)).toBe(
      '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt; &amp; co',
    );
  });

  it('turns null and undefined into an empty string and keeps numbers', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(1500)).toBe('1500');
  });
});

describe('serializeJsonLd', () => {
  const hostile = {
    '@type': 'Article',
    headline: 'Título</script><script>alert(1)</script>',
    description: 'A <!-- comment --> & \u2028 line',
  };

  it('never closes the script element it is written into', () => {
    const out = serializeJsonLd(hostile);
    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('\u2028');
  });

  it('is still the same JSON', () => {
    expect(JSON.parse(serializeJsonLd(hostile))).toEqual(hostile);
  });
});

describe('safeInternalPath', () => {
  it.each([
    ['/', '/'],
    ['/rides/abc?tab=1#top', '/rides/abc?tab=1#top'],
    ['/empresas/registro', '/empresas/registro'],
    ['/a:b', '/a:b'],
  ])('keeps the same-site path %s', (raw, expected) => {
    expect(safeInternalPath(raw)).toBe(expected);
  });

  it.each([
    ['//evil.example'],
    ['/\\evil.example'],
    ['/\\/evil.example'],
    ['\\\\evil.example'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['https://evil.example'],
    ['javascript:alert(1)'],
    [' /rides'],
    [''],
    [null],
    [undefined],
  ])('refuses %j', (raw) => {
    expect(safeInternalPath(raw)).toBeNull();
  });
});

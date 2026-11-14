import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The founder's WhatsApp number must never be hardcoded again: the support number comes from
// the server (get_support_contact / request_ride_help), see spec 2026-11-07-support-ride-owner.

const ROOT = resolve(__dirname, '../../../..');
// Also the spaced form used in copy ("+53 5662 1636").
const NEEDLE = /5662[ -]?1636/;
const SKIP_DIRS = new Set(['node_modules', 'store-metadata', '__tests__', '.next', 'dist', '.expo']);
const EXTENSIONS = ['.ts', '.tsx', '.json'];

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(name);
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full, out);
    } else if (EXTENSIONS.some((ext) => name.endsWith(ext)) && !isTestFile(name)) {
      out.push(full);
    }
  }
}

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const pkg of readdirSync(groupDir)) {
      roots.push(join(groupDir, pkg, 'src'), join(groupDir, pkg, 'app'));
    }
  }
  return roots;
}

describe('no hardcoded support phone', () => {
  it('keeps the founder number out of apps/ and packages/ source', () => {
    const files: string[] = [];
    for (const root of sourceRoots()) walk(root, files);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => readFileSync(file, 'utf8').match(NEEDLE) !== null)
      .map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'))
      .sort();
    expect(offenders).toEqual([]);
  });
});

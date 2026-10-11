import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VI } from './i18n.vi';
import { t, tn } from './i18n';
import { ROAD_CLASS_NAMES } from './logic/roadClass';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('i18n') ? [p] : [];
  });
}

/** Every literal passed to t('…') or tn(n, '…', '…') in the app. */
function literalKeys(): Set<string> {
  const keys = new Set<string>();
  for (const f of sources(SRC)) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1]);
    for (const m of s.matchAll(/\btn\([^,]+,\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'/g)) {
      keys.add(m[1]);
      keys.add(m[2]);
    }
  }
  return keys;
}

/** Keys passed to t() as variables: engine stages/modes, bundle and example names, etc. */
const DYNAMIC = [
  ...Object.values(ROAD_CLASS_NAMES),
  'motorbike', 'car', 'bus', 'other',
  'street', 'intersection', 'underpass',
  'high', 'medium', 'low',
  'sudden', 'structural', 'baseline', 'control', 'reference',
  'downloading city', 'routing', 'replanning', 'simulating', 'reference run:',
];

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  it('has a Vietnamese translation for every UI string', () => {
    const keys = literalKeys();
    expect(keys.size).toBeGreaterThan(300);
    const missing = [...keys, ...DYNAMIC].filter((k) => !VI[k]);
    expect(missing).toEqual([]);
  });

  it('keeps the same placeholders in translations', () => {
    const bad = Object.entries(VI).filter(([en, vi]) => placeholders(en).join() !== placeholders(vi).join());
    expect(bad).toEqual([]);
  });

  it('translates the bundled example scenario names', () => {
    const dir = join(SRC, '../../scenarios');
    const names = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { name?: string }).name)
      .filter((n): n is string => !!n);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n) => !VI[n])).toEqual([]);
  });

  it('falls back to English and fills placeholders', () => {
    expect(t('Rain zone {n}', { n: 2 })).toBe('Rain zone 2');
    expect(t('not a key')).toBe('not a key');
    expect(tn(1, '{n} lane', '{n} lanes')).toBe('1 lane');
    expect(tn(3, '{n} lane', '{n} lanes')).toBe('3 lanes');
  });
});

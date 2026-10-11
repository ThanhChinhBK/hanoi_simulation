import { VI } from './i18n.vi';

/**
 * UI language. Strings are written in English in the code and wrapped in `t()`;
 * the English text is the lookup key into the Vietnamese dictionary (`i18n.vi.ts`).
 * Missing translations fall back to English. Switching language reloads the page
 * (the scenario is kept in the URL hash).
 */
export type Lang = 'vi' | 'en';

const STORAGE_KEY = 'hanoi-sim.lang';

function detect(): Lang {
  if (typeof window === 'undefined') return 'en';
  const q = new URLSearchParams(window.location.search).get('lang');
  if (q === 'vi' || q === 'en') return q;
  try {
    const s = window.localStorage.getItem(STORAGE_KEY);
    if (s === 'vi' || s === 'en') return s;
  } catch {
    /* storage blocked */
  }
  return 'vi';
}

export const lang: Lang = detect();
export const locale = lang === 'vi' ? 'vi-VN' : 'en-US';

type Vars = Record<string, string | number>;

const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

/** Translate an English UI string; `{name}` placeholders are filled from `vars`. */
export function t(s: string, vars?: Vars): string {
  return fill((lang === 'vi' && VI[s]) || s, vars);
}

/** Plural-aware `t`: picks `one` or `other` by `n` (English); `{n}` is filled in. */
export function tn(n: number, one: string, other: string, vars?: Vars): string {
  return t(n === 1 ? one : other, { n, ...vars });
}

/** Engine progress stages ("routing", "reference run: simulating", …). */
export function tStage(stage: string): string {
  const ref = 'reference run: ';
  if (stage.startsWith(ref)) return `${t('reference run:')} ${tStage(stage.slice(ref.length))}`;
  return t(stage);
}

export function setLang(l: Lang) {
  try {
    window.localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* storage blocked */
  }
  const url = new URL(window.location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.delete('lang');
    window.location.replace(url.href);
  } else window.location.reload();
}

if (typeof document !== 'undefined') document.documentElement.lang = lang;

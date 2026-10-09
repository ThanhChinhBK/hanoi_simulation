/** "HH:MM" or "HH:MM:SS" → ms since midnight (NaN if malformed). */
export function parseTime(s: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return NaN;
  const [h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 47 || mi > 59 || se > 59) return NaN;
  return ((h * 60 + mi) * 60 + se) * 1000;
}

/** ms since midnight → "HH:MM". */
export function formatTime(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

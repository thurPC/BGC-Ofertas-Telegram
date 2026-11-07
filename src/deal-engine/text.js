export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9./+\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compactKey(value) {
  return normalizeText(value).replace(/[\s./+\-]+/g, '');
}

export function tokens(value) {
  return normalizeText(value)
    .split(' ')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function haystackOf(parts) {
  return normalizeText(parts.filter((item) => item != null && item !== '').join(' '));
}

export function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function asPositiveNumber(value) {
  const parsed = parseNumber(value);
  if (parsed == null || parsed < 0) return null;
  return parsed;
}

export function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (value == null || value === '') continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function includesPhrase(haystack, phrase) {
  const needle = normalizeText(phrase);
  if (!needle) return false;
  return ` ${haystack} `.includes(` ${needle} `) || haystack.includes(needle);
}

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

export function isFreshSnapshot(offer, maxAgeMs = 30 * 60 * 1000, now = Date.now()) {
  if (!offer?.fetchedAt) return false;
  const age = now - new Date(offer.fetchedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

export class CyclePriceCache {
  constructor({ maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.map = new Map();
  }

  get(key, now = Date.now()) {
    if (!key) return null;
    const hit = this.map.get(key);
    if (!hit) return null;
    if (now - hit.at > this.maxAgeMs) {
      this.map.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key, value, now = Date.now()) {
    if (!key) return;
    this.map.set(key, { value, at: now });
  }
}

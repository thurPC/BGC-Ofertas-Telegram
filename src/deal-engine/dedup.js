import { identityMatchesPublished, offerIdentityKeys } from '../services/offer-identity.js';
import { compactKey } from './text.js';
import { PRODUCT_FAMILIES } from './taxonomy.js';

const HOUR_MS = 60 * 60 * 1000;

export function variantKey(identity) {
  if (!identity?.key) return null;
  const bits = Object.entries(identity.variant || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${compactKey(value)}`)
    .join('|');
  return `${identity.key}#${bits}`;
}

export function significantImprovement(candidate, previous, config) {
  if (!previous) return true;
  const drop = config?.significantDropPercent ?? 8;
  const gain = config?.significantScoreGain ?? 10;
  const oldPrice = Number(previous.price);
  const newPrice = Number(candidate.finalPrice ?? candidate.offer?.price);
  const oldScore = Number(previous.dealScore);
  const newScore = Number(candidate.deal?.dealScore);
  if (Number.isFinite(oldPrice) && Number.isFinite(newPrice) && oldPrice > 0) {
    const percent = ((oldPrice - newPrice) / oldPrice) * 100;
    if (percent >= drop) return true;
  }
  if (Number.isFinite(oldScore) && Number.isFinite(newScore) && newScore - oldScore >= gain) return true;
  return false;
}

export function evaluateDedup(evaluated, context = {}) {
  const offer = evaluated.offer || {};
  const identity = evaluated.identity || {};
  const config = context.config || {};
  const now = context.now || new Date();
  const keys = offerIdentityKeys(offer);
  const publishedKeys = context.publishedKeys || [];
  if (identityMatchesPublished(offer, publishedKeys) && !context.allowPublishedRepeat) {
    const last = (context.publications || []).find((item) => item.identityKey === identity.key);
    if (!significantImprovement(evaluated, last, config)) {
      return { duplicate: true, reason: 'published-identity', cooldown: true };
    }
  }

  const vKey = variantKey(identity);
  const publications = context.publications || [];
  const cooldownMs = (config.cooldownHours ?? 24) * HOUR_MS;
  const variantMs = (config.variantCooldownHours ?? 12) * HOUR_MS;

  const lastSame = publications
    .filter((item) => item.identityKey && item.identityKey === identity.key)
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  if (lastSame && now - new Date(lastSame.at) < cooldownMs && !significantImprovement(evaluated, lastSame, config)) {
    return { duplicate: true, reason: 'product-cooldown', cooldown: true };
  }

  const lastVariant = publications
    .filter((item) => item.variantKey && item.variantKey === vKey)
    .sort((a, b) => new Date(b.at) - new Date(a.at))[0];
  if (lastVariant && now - new Date(lastVariant.at) < variantMs && !significantImprovement(evaluated, lastVariant, config)) {
    return { duplicate: true, reason: 'variant-cooldown', cooldown: true };
  }

  if (context.cycleIdentityKeys instanceof Set && identity.key && context.cycleIdentityKeys.has(identity.key)) {
    return { duplicate: true, reason: 'same-cycle', cooldown: false };
  }

  const titleKey = compactKey(offer.name);
  if (titleKey && context.cycleTitleKeys instanceof Set && context.cycleTitleKeys.has(titleKey)) {
    return { duplicate: true, reason: 'similar-title', cooldown: false };
  }

  return { duplicate: false, reason: null, cooldown: false, keys, variantKey: vKey };
}

export function applyDiversity(selected, config = {}) {
  const maxBrand = config.maxPerBrandPerCycle ?? 2;
  const familyShare = config.maxPerFamilyShare ?? 0.7;
  const kept = [];
  const brands = new Map();
  const families = new Map();
  for (const item of selected) {
    const brand = item.identity?.brand || 'unknown';
    const family = item.classification?.family || PRODUCT_FAMILIES.UNKNOWN;
    const brandCount = brands.get(brand) || 0;
    if (brandCount >= maxBrand) continue;
    const nextFamilies = new Map(families);
    nextFamilies.set(family, (nextFamilies.get(family) || 0) + 1);
    const total = kept.length + 1;
    const dominant = Math.max(...nextFamilies.values());
    if (total >= 3 && dominant / total > familyShare) continue;
    brands.set(brand, brandCount + 1);
    families.set(family, (families.get(family) || 0) + 1);
    kept.push(item);
  }
  return kept;
}

import { QUEUE_STATUS } from './defaults.js';
import { effectivePrice } from './price-intelligence.js';
import { variantKey } from './dedup.js';

export function buildQueueItem(evaluated, extras = {}) {
  const offer = evaluated.offer || {};
  const identity = evaluated.identity || {};
  const classification = evaluated.classification || {};
  const deal = evaluated.deal || {};
  const confidence = evaluated.confidence || {};
  const stats = evaluated.stats || {};
  return {
    status: extras.status || QUEUE_STATUS.EVALUATED,
    product: {
      name: offer.name,
      brand: identity.brand,
      model: identity.model,
      gtin: identity.gtin,
      mpn: identity.mpn
    },
    variant: identity.variant || {},
    category: classification.taxonomyId,
    family: classification.family,
    dealScore: deal.dealScore ?? 0,
    confidenceScore: confidence.confidenceScore ?? 0,
    reasons: deal.reasons || [],
    price: offer.price ?? null,
    finalPrice: evaluated.finalPrice ?? effectivePrice(offer),
    historical: {
      median30: stats.median30 ?? null,
      min: stats.min ?? null,
      sampleSize: stats.sampleSize ?? 0
    },
    savings: evaluated.comparison?.savings ?? null,
    affiliateUrl: offer.url || null,
    discoveredAt: offer.fetchedAt || extras.discoveredAt || new Date().toISOString(),
    validatedAt: extras.validatedAt || new Date().toISOString(),
    identityKey: identity.key,
    variantKey: variantKey(identity),
    rejection: extras.rejection || null,
    offer
  };
}

export function rankQueue(items, limit) {
  const ranked = [...(items || [])].sort((a, b) => {
    const score = (b.dealScore || 0) - (a.dealScore || 0);
    if (score !== 0) return score;
    const conf = (b.confidenceScore || 0) - (a.confidenceScore || 0);
    if (conf !== 0) return conf;
    return (a.finalPrice || 0) - (b.finalPrice || 0);
  });
  if (Number.isInteger(limit) && limit > 0) return ranked.slice(0, limit);
  return ranked;
}

export function revalidateItem(item, currentOffer) {
  if (!currentOffer) {
    return { ok: false, status: QUEUE_STATUS.EXPIRED, reason: 'offer-missing' };
  }
  const oldPrice = Number(item.finalPrice ?? item.price);
  const newPrice = Number(currentOffer.price);
  if (Number.isFinite(oldPrice) && Number.isFinite(newPrice) && newPrice > oldPrice * 1.02) {
    return { ok: false, status: QUEUE_STATUS.EXPIRED, reason: 'price-changed' };
  }
  const stock = currentOffer.stock ?? currentOffer.stockStatus;
  if (stock === false || stock === 'out_of_stock' || stock === 0) {
    return { ok: false, status: QUEUE_STATUS.EXPIRED, reason: 'out-of-stock' };
  }
  if (!currentOffer.url) {
    return { ok: false, status: QUEUE_STATUS.FAILED, reason: 'invalid-link' };
  }
  return { ok: true, status: QUEUE_STATUS.QUEUED, reason: null };
}

export async function persistQueue(priceStore, items = []) {
  if (!priceStore?.replaceQueue) return items;
  await priceStore.replaceQueue(items);
  return items;
}

export async function loadPersistedQueue(priceStore) {
  if (!priceStore?.queueItems) return [];
  return priceStore.queueItems();
}

export async function markQueueStatus(priceStore, identityKey, status, extra = {}) {
  if (!priceStore?.updateQueueItem || !identityKey) return null;
  return priceStore.updateQueueItem(identityKey, { status, ...extra });
}

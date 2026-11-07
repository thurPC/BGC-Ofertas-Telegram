import { effectivePrice } from './price-intelligence.js';
import { sameProductIdentity, variantsCompatible } from './identity.js';
import { asPositiveNumber, round } from './text.js';

export function comparableOffers(target, catalog = []) {
  return (catalog || []).filter((item) => {
    if (!item || item === target) return false;
    if (!target?.identity || !item.identity) return false;
    if (!sameProductIdentity(target.identity, item.identity)) return false;
    if (!variantsCompatible(target.identity, item.identity)) return false;
    const leftCondition = String(target.offer?.condition || item.offer?.condition || 'new').toLowerCase();
    const rightCondition = String(item.offer?.condition || 'new').toLowerCase();
    return leftCondition === rightCondition;
  });
}

export function compareMarkets(evaluated, catalog = []) {
  const price = evaluated.finalPrice ?? effectivePrice(evaluated.offer);
  const peers = comparableOffers(evaluated, catalog)
    .map((item) => ({
      source: item.offer?.source || item.offer?.store,
      seller: item.offer?.seller || item.offer?.store,
      price: item.finalPrice ?? effectivePrice(item.offer)
    }))
    .filter((item) => item.price != null);

  if (price == null) {
    return {
      comparableCount: peers.length,
      cheapest: null,
      savings: null,
      percentile: null,
      confidence: 0,
      reason: 'missing-price'
    };
  }

  if (!peers.length) {
    return {
      comparableCount: 0,
      cheapest: price,
      savings: null,
      percentile: null,
      confidence: 25,
      reason: 'no-peers'
    };
  }

  const cheaper = peers.filter((item) => item.price < price);
  const cheapest = Math.min(price, ...peers.map((item) => item.price));
  const savings = cheapest < price ? round(price - cheapest) : 0;
  const betterThan = peers.filter((item) => item.price >= price).length / peers.length;
  return {
    comparableCount: peers.length,
    cheapest,
    savings,
    percentile: round(betterThan * 100),
    isCheapest: price <= cheapest,
    confidence: Math.min(90, 40 + peers.length * 12),
    reason: peers.length ? 'compared' : 'no-peers',
    peers
  };
}

export function netSavings(offer, comparison, stats) {
  const price = effectivePrice(offer);
  if (price == null) return null;
  const vsMedian = stats?.median30 != null ? round(stats.median30 - price) : null;
  const vsPeers = comparison?.savings != null ? comparison.savings : null;
  const coupon = asPositiveNumber(offer.couponDiscountAmount) || 0;
  return {
    vsMedian,
    vsPeers,
    coupon,
    freight: asPositiveNumber(offer.freight ?? offer.shipping) || 0
  };
}

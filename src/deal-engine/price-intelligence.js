import { asPositiveNumber, clamp, round } from './text.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return round((sorted[mid - 1] + sorted[mid]) / 2);
  return sorted[mid];
}

function mean(values) {
  if (!values.length) return null;
  return round(values.reduce((sum, item) => sum + item, 0) / values.length);
}

function withinDays(snapshots, days, now) {
  const cutoff = now.getTime() - days * DAY_MS;
  return snapshots.filter((item) => {
    const at = new Date(item.at).getTime();
    return Number.isFinite(at) && at >= cutoff;
  });
}

export function effectivePrice(offer = {}) {
  const listed = asPositiveNumber(offer.price);
  if (listed == null) return null;
  const freight = asPositiveNumber(offer.freight ?? offer.shipping ?? offer.shippingPrice) || 0;
  const coupon = asPositiveNumber(offer.couponDiscountAmount) || 0;
  const couponPrice = asPositiveNumber(offer.couponEstimatedPrice);
  const pix = asPositiveNumber(offer.pixPrice);
  const base = couponPrice != null ? couponPrice : Math.max(0, listed - coupon);
  const chosen = pix != null && pix < base ? pix : base;
  return round(chosen + freight);
}

export function listedDiscountPercent(offer = {}) {
  const previous = asPositiveNumber(offer.previousPrice);
  const current = asPositiveNumber(offer.price);
  if (previous == null || current == null || previous <= current) return null;
  return round(((previous - current) / previous) * 100);
}

export function detectArtificialOriginal(offer = {}, stats = null) {
  const previous = asPositiveNumber(offer.previousPrice);
  const current = asPositiveNumber(offer.price);
  if (previous == null || current == null || previous <= current) {
    return { artificial: false, reason: null };
  }
  const advertised = listedDiscountPercent(offer);
  if (stats?.median30 != null && previous > stats.median30 * 1.35 && advertised >= 40) {
    return { artificial: true, reason: 'original-above-median' };
  }
  if (stats?.max != null && previous > stats.max * 1.15 && advertised >= 30) {
    return { artificial: true, reason: 'original-above-observed-max' };
  }
  if (stats?.sampleSize >= 5 && stats.median30 != null && previous > stats.median30 * 1.5) {
    return { artificial: true, reason: 'inflated-list-price' };
  }
  return { artificial: false, reason: null };
}

export function summarizeHistory(snapshots = [], now = new Date()) {
  const prices = snapshots
    .map((item) => asPositiveNumber(item.finalPrice ?? item.price))
    .filter((item) => item != null);
  const last7 = withinDays(snapshots, 7, now)
    .map((item) => asPositiveNumber(item.finalPrice ?? item.price))
    .filter((item) => item != null);
  const last30 = withinDays(snapshots, 30, now)
    .map((item) => asPositiveNumber(item.finalPrice ?? item.price))
    .filter((item) => item != null);
  const last90 = withinDays(snapshots, 90, now)
    .map((item) => asPositiveNumber(item.finalPrice ?? item.price))
    .filter((item) => item != null);

  const changes = [];
  const ordered = [...snapshots].sort((a, b) => new Date(a.at) - new Date(b.at));
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = asPositiveNumber(ordered[i - 1].finalPrice ?? ordered[i - 1].price);
    const next = asPositiveNumber(ordered[i].finalPrice ?? ordered[i].price);
    if (prev != null && next != null && prev !== next) changes.push(next - prev);
  }

  let trend = 'insufficient';
  if (last7.length >= 2 && last30.length >= 3) {
    const recent = mean(last7);
    const older = mean(last30);
    if (recent != null && older != null) {
      if (recent < older * 0.97) trend = 'falling';
      else if (recent > older * 1.03) trend = 'rising';
      else trend = 'stable';
    }
  }

  return {
    sampleSize: prices.length,
    mean7: mean(last7),
    mean30: mean(last30),
    mean90: mean(last90),
    median30: median(last30),
    median90: median(last90),
    min: prices.length ? round(Math.min(...prices)) : null,
    max: prices.length ? round(Math.max(...prices)) : null,
    changeFrequency: snapshots.length ? round(changes.length / Math.max(1, snapshots.length - 1), 3) : 0,
    trend,
    insufficient: last30.length < 3
  };
}

export function historicalDiscount(price, stats) {
  if (price == null || stats?.median30 == null || stats.median30 <= 0) return null;
  return round(((stats.median30 - price) / stats.median30) * 100);
}

export function proximityToMin(price, stats) {
  if (price == null || stats?.min == null || stats.min <= 0) return null;
  if (price <= stats.min) return 100;
  const span = (stats.median30 ?? stats.mean30 ?? price) - stats.min;
  if (!span || span <= 0) return price <= stats.min ? 100 : 0;
  return clamp(round((1 - (price - stats.min) / span) * 100), 0, 100);
}

export function createSnapshot(offer, identity, extras = {}) {
  const listed = asPositiveNumber(offer.price);
  const freight = asPositiveNumber(offer.freight ?? offer.shipping ?? offer.shippingPrice) || 0;
  const coupon = asPositiveNumber(offer.couponDiscountAmount) || 0;
  const finalPrice = effectivePrice(offer);
  return {
    at: extras.at || offer.fetchedAt || new Date().toISOString(),
    identityKey: identity?.key || extras.identityKey || null,
    source: offer.source || extras.source || null,
    seller: offer.seller || offer.store || null,
    listedPrice: listed,
    advertisedPrevious: asPositiveNumber(offer.previousPrice),
    freight,
    coupon,
    finalPrice,
    stock: offer.stock ?? offer.stockStatus ?? null,
    url: offer.url || null,
    condition: offer.condition || 'new'
  };
}

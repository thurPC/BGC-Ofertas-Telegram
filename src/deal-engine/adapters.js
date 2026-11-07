import { normalizeFetchedOffer } from '../sources/source-interface.js';
import { asPositiveNumber, unique } from './text.js';

function text(value) {
  const raw = String(value ?? '').trim();
  return raw || null;
}

export function normalizeDiscoveredProduct(raw = {}, sourceName = 'unknown') {
  const base = normalizeFetchedOffer(raw, sourceName);
  return {
    ...base,
    sourceId: text(raw.sourceId) || sourceName,
    productId: text(raw.productId || raw.itemId || raw.externalId || raw.id),
    gtin: text(raw.gtin || raw.ean || raw.barcode),
    ean: text(raw.ean || raw.gtin),
    mpn: text(raw.mpn || raw.manufacturerPartNumber),
    brand: text(raw.brand || raw.marca),
    model: text(raw.model || raw.modelo),
    variant: raw.variant || null,
    storeCategory: text(raw.storeCategory || raw.categoryName || raw.category),
    specs: raw.specs || raw.specifications || null,
    freight: asPositiveNumber(raw.freight ?? raw.shipping ?? raw.shippingFee ?? raw.shippingPrice),
    coupon: text(raw.coupon) || base.coupon,
    couponDiscountAmount: asPositiveNumber(raw.couponDiscountAmount),
    stock: raw.stock ?? raw.stockStatus ?? raw.inStock ?? null,
    seller: text(raw.seller) || base.seller,
    sales: asPositiveNumber(raw.sales ?? raw.soldCount),
    ratingStar: asPositiveNumber(raw.ratingStar ?? raw.rating),
    imageUrl: text(raw.imageUrl || raw.image) || base.imageUrl,
    url: text(raw.url || raw.link || raw.affiliateUrl) || base.url,
    originalUrl: text(raw.originalUrl || raw.productLink),
    affiliateUrl: text(raw.affiliateUrl || raw.url),
    condition: text(raw.condition) || 'new',
    voltage: text(raw.voltage),
    capacity: text(raw.capacity),
    commissionRate: asPositiveNumber(raw.commissionRate),
    itemId: text(raw.itemId),
    shopId: text(raw.shopId),
    productLink: text(raw.productLink),
    externalId: text(raw.externalId || raw.id) || base.externalId,
    source: sourceName,
    fetchedAt: raw.fetchedAt || base.fetchedAt || new Date().toISOString()
  };
}

export function mergeNormalizedFields(offer, sourceName) {
  const normalized = normalizeDiscoveredProduct(offer, offer?.source || sourceName);
  return {
    ...offer,
    ...normalized,
    name: offer?.name || normalized.name,
    url: offer?.url || normalized.url,
    price: offer?.price ?? normalized.price,
    source: offer?.source || sourceName
  };
}

export function uniqueNormalized(offers) {
  const seen = new Set();
  const result = [];
  for (const offer of offers || []) {
    const key = unique([offer.externalId, offer.url, offer.productId]).join('|');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(offer);
  }
  return result;
}

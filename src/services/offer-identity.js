import { extractShopeeIds } from './shopee-affiliate-client.js';

function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseShopeeExternalId(externalId) {
  const value = String(externalId ?? '').trim().toLowerCase();
  const full = /^shopee:(\d+):(\d+)$/.exec(value);
  if (full) return { shopId: full[1], itemId: full[2] };
  const itemOnly = /^shopee:(\d+)$/.exec(value);
  if (itemOnly) return { shopId: null, itemId: itemOnly[1] };
  return null;
}

function isShortAffiliateHost(host) {
  return host === 's.shopee.com.br' || host === 'shope.ee' || host === 'shp.ee';
}

function canonicalizeHttpUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return raw.toLowerCase();
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (!isShortAffiliateHost(host)) {
      parsed.search = '';
      parsed.hash = '';
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export function canonicalShopeeExternalId(offer = {}) {
  const fromExternal = parseShopeeExternalId(offer.externalId);
  const fromProduct = extractShopeeIds(offer.productLink);
  const fromUrl = extractShopeeIds(offer.url);
  const shopId =
    String(offer.shopId ?? '').trim() ||
    fromExternal?.shopId ||
    fromProduct?.shopId ||
    fromUrl?.shopId ||
    null;
  const itemId =
    String(offer.itemId ?? '').trim() ||
    fromExternal?.itemId ||
    fromProduct?.itemId ||
    fromUrl?.itemId ||
    null;
  if (itemId && shopId) return `shopee:${shopId}:${itemId}`;
  if (itemId) return `shopee:${itemId}`;
  return null;
}

export function expandIdentityKey(key) {
  const value = String(key ?? '').trim().toLowerCase();
  return value ? [value] : [];
}

function parseShopeeKey(key) {
  return parseShopeeExternalId(key);
}

function shopeeIdsOverlap(left, right) {
  if (!left?.itemId || !right?.itemId || left.itemId !== right.itemId) return false;
  if (!left.shopId || !right.shopId) return true;
  return left.shopId === right.shopId;
}

export function offerIdentityKeys(offer = {}) {
  const keys = [];
  const seen = new Set();
  const add = (value) => {
    for (const key of expandIdentityKey(value)) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  };

  const canonical = canonicalShopeeExternalId(offer);
  if (canonical) add(canonical);
  else if (offer.externalId) add(offer.externalId);

  add(canonicalizeHttpUrl(offer.productLink));
  add(canonicalizeHttpUrl(offer.url));

  const name = normalizeKey(offer.name);
  const store = normalizeKey(offer.store);
  if (name && store) add(`name:${name}|store:${store}`);

  return keys;
}

export function expandPublishedKeys(publishedKeys) {
  const keys = new Set();
  for (const key of publishedKeys || []) {
    for (const item of expandIdentityKey(key)) keys.add(item);
  }
  return keys;
}

function collectedShopeeIds(keys) {
  const ids = [];
  for (const key of keys) {
    const parsed = parseShopeeKey(key);
    if (parsed) ids.push(parsed);
  }
  return ids;
}

export function identityMatchesPublished(offer, publishedKeys) {
  const known = expandPublishedKeys(publishedKeys);
  if (known.size === 0) return false;
  const keys = offerIdentityKeys(offer);
  if (keys.some((key) => known.has(key))) return true;
  const knownIds = collectedShopeeIds(known);
  const offerIds = collectedShopeeIds(keys);
  return offerIds.some((left) => knownIds.some((right) => shopeeIdsOverlap(left, right)));
}

export function identityKeySet(offer) {
  return new Set(offerIdentityKeys(offer));
}

export function offersShareIdentity(left, right) {
  const leftKeys = offerIdentityKeys(left);
  const rightKeys = offerIdentityKeys(right);
  const leftSet = new Set(leftKeys);
  if (rightKeys.some((key) => leftSet.has(key))) return true;
  const leftIds = collectedShopeeIds(leftKeys);
  const rightIds = collectedShopeeIds(rightKeys);
  return leftIds.some((a) => rightIds.some((b) => shopeeIdsOverlap(a, b)));
}

import crypto from 'node:crypto';
import { extractAsin } from './link-extractor.js';
import { analyzeExclusion, exclusionMessage, isExcludedProduct } from './exclusion-filter.js';
import { calculateDiscount, validateOfferInput } from './validation-service.js';
import { offerIdentityKeys, offersShareIdentity } from './offer-identity.js';

export const OFFER_STATUS = {
  DRAFT: 'rascunho',
  READY: 'pronta',
  PUBLISHED: 'publicada',
  EXPIRED: 'expirada',
  CANCELLED: 'cancelada'
};

const EDITABLE = new Set([OFFER_STATUS.DRAFT, OFFER_STATUS.READY]);
const INACTIVE = new Set([OFFER_STATUS.CANCELLED, OFFER_STATUS.EXPIRED]);

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'ttclid', 'yclid',
  'mc_cid', 'mc_eid', 'igshid', 'si', 'spm', 'scm',
  'ref', 'ref_', 'tag', 'linkcode', 'camp', 'creative', 'creativeasin',
  'ascsubtag', 'asc_campaign', 'asc_refurl', 'asc_source',
  'matt_word', 'matt_tool', 'matt_source',
  'afiliado', 'affiliate', 'aff_id', 'affid', 'affiliate_id',
  'partner', 'partner_id', 'smtt', 'xptdk'
]);

function nowIso() {
  return new Date().toISOString();
}

function preserveOptionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isTrackingParam(key) {
  const name = String(key ?? '').toLowerCase();
  if (!name) return false;
  if (TRACKING_PARAMS.has(name)) return true;
  return name.startsWith('utm_') || name.startsWith('mt_');
}

function normalizeStore(store) {
  const key = normalizeKey(store);
  if (!key) return '';
  if (key === 'amzn' || key.startsWith('amazon') || key.startsWith('amzn ')) return 'amazon';
  if (key.includes('mercado livr') || key.includes('mercadolivre') || key.includes('mercadolibre')) {
    return 'mercado livre';
  }
  if (key.startsWith('shopee')) return 'shopee';
  return key;
}

function mercadoLivreId(url) {
  const text = String(url ?? '');
  const product = text.match(/\/p\/(MLB\d+)/i);
  if (product) return product[1].toUpperCase();
  const item = text.match(/(?:\/|-)(MLB-?\d{8,})/i);
  return item ? item[1].replace(/-/g, '').toUpperCase() : null;
}

function shopeeProductId(url) {
  const match = String(url ?? '').match(/\/product\/(\d+)\/(\d+)/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function isAmazonHost(host) {
  const value = String(host ?? '').toLowerCase();
  return value.includes('amazon') || value.includes('amzn') || value === 'a.co';
}

export function canonicalizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return text.toLowerCase();
    url.hash = '';
    url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
    url.protocol = 'https:';
    const asin = extractAsin(url.toString());
    if (asin && isAmazonHost(url.hostname)) {
      return `https://${url.hostname}/dp/${asin}`;
    }
    const mlb = mercadoLivreId(url.toString());
    if (mlb && url.hostname.includes('mercado')) {
      return `https://${url.hostname}/p/${mlb}`;
    }
    const shopee = shopeeProductId(url.pathname);
    if (shopee && url.hostname.includes('shopee')) {
      return `https://${url.hostname}/product/${shopee}`;
    }
    const kept = [...url.searchParams.entries()]
      .filter(([key]) => !isTrackingParam(key))
      .map(([key, value]) => [key.toLowerCase(), value])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    url.search = '';
    for (const [key, value] of kept) url.searchParams.append(key, value);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol}//${url.hostname}${path}${url.search}`;
  } catch {
    return text.toLowerCase();
  }
}

function candidateUrls(offer) {
  return [offer?.url, offer?.resolvedProductUrl, offer?.originalAffiliateUrl]
    .map((value) => canonicalizeUrl(value))
    .filter(Boolean);
}

function urlLooksAmazon(raw) {
  try {
    return isAmazonHost(new URL(String(raw)).hostname);
  } catch {
    return false;
  }
}

export function identityKeys(offer) {
  const keys = new Set();
  const externalId = String(offer?.externalId ?? '').trim();
  if (externalId) keys.add(`ext:${externalId}`);
  const urls = [offer?.url, offer?.resolvedProductUrl, offer?.originalAffiliateUrl];
  const asin = String(offer?.asin ?? '').trim().toUpperCase() || null;
  const amazonUrls = urls.filter((value) => value && urlLooksAmazon(value));
  const foundAsin = asin || amazonUrls.map((value) => extractAsin(value)).find(Boolean);
  if (foundAsin) keys.add(`asin:${String(foundAsin).toUpperCase()}`);
  for (const raw of urls) {
    const mlb = mercadoLivreId(raw);
    if (mlb) keys.add(`mlb:${mlb}`);
    const shopee = shopeeProductId(raw);
    if (shopee) keys.add(`shopee:${shopee}`);
  }
  for (const url of candidateUrls(offer)) keys.add(`url:${url}`);
  const name = normalizeKey(offer?.name);
  const store = normalizeStore(offer?.store);
  if (name && store) keys.add(`item:${name}|${store}`);
  return keys;
}

export function createOfferId() {
  return crypto.randomBytes(6).toString('hex');
}

export function fingerprint(offer) {
  const name = normalizeKey(offer.name);
  const url = canonicalizeUrl(offer.url);
  const store = normalizeStore(offer.store);
  return `${name}|${store}|${url}`;
}

export function findDuplicates(offers, candidate, { excludeId } = {}) {
  const targetKeys = identityKeys(candidate);
  const target = fingerprint(candidate);
  return (offers || []).filter((offer) => {
    if (excludeId && offer.id === excludeId) return false;
    if (INACTIVE.has(offer.status)) return false;
    if (offersShareIdentity(offer, candidate)) return true;
    const keys = identityKeys(offer);
    for (const key of targetKeys) {
      if (keys.has(key)) return true;
    }
    return fingerprint(offer) === target;
  });
}

export function publishedDuplicates(offers, candidate, { excludeId } = {}) {
  return findDuplicates(offers, candidate, { excludeId }).filter(
    (offer) => offer.status === OFFER_STATUS.PUBLISHED
  );
}

export function duplicateMessage(duplicates = []) {
  const published = duplicates.filter((item) => item.status === OFFER_STATUS.PUBLISHED);
  const first = (published[0] || duplicates[0]) ?? null;
  const id = first?.id ? ` (ID ${first.id})` : '';
  if (published.length) {
    return `Esta promoção já foi publicada no canal${id}. Não será enviada de novo.`;
  }
  if (duplicates.length) {
    return `Esta promoção já está cadastrada${id}. Não será publicada de novo.`;
  }
  return 'Esta promoção já existe e não será repetida.';
}

function applyExpiry(offer, at = new Date()) {
  if (!offer.validUntil) return offer;
  if ([OFFER_STATUS.EXPIRED, OFFER_STATUS.CANCELLED].includes(offer.status)) return offer;
  const until = new Date(offer.validUntil);
  if (!Number.isNaN(until.getTime()) && until.getTime() < at.getTime()) {
    return { ...offer, status: OFFER_STATUS.EXPIRED };
  }
  return offer;
}

export class OfferService {
  constructor(storage, { settingsService, couponService } = {}) {
    this.storage = storage;
    this.settingsService = settingsService;
    this.couponService = couponService;
  }

  async exclusionOptions() {
    if (this.settingsService?.exclusionOptions) {
      return this.settingsService.exclusionOptions();
    }
    return {};
  }

  async list() {
    const db = await this.storage.read();
    const offers = db.offers.map((offer) => applyExpiry(offer));
    const changed = offers.some((offer, index) => offer.status !== db.offers[index].status);
    if (changed) {
      await this.storage.update((current) => {
        current.offers = current.offers.map((offer) => applyExpiry(offer));
        return current;
      });
    }
    return offers;
  }

  async getById(id) {
    const offers = await this.list();
    return offers.find((offer) => offer.id === id) ?? null;
  }

  async create(input, { actorId } = {}) {
    const validation = validateOfferInput(input);
    if (!validation.ok) {
      return { ok: false, errors: validation.errors };
    }
    const exclusionOptions = await this.exclusionOptions();
    if (isExcludedProduct(validation.offer, exclusionOptions)) {
      return { ok: false, error: exclusionMessage(analyzeExclusion(validation.offer, exclusionOptions).reasons) };
    }

    const candidate = {
      ...validation.offer,
      category: preserveOptionalText(input.category),
      description: preserveOptionalText(input.description),
      url: input.url || validation.offer.url,
      imageUrl: input.imageUrl || validation.offer.imageUrl || null,
      resolvedProductUrl: input.resolvedProductUrl || null,
      originalAffiliateUrl: input.originalAffiliateUrl || input.url || validation.offer.url,
      asin: input.asin || null,
      externalId: input.externalId ?? null,
      productLink: input.productLink ?? null,
      itemId: input.itemId ?? null,
      shopId: input.shopId ?? null
    };
    const offer = {
      id: createOfferId(),
      ...validation.offer,
      url: candidate.url,
      imageUrl: candidate.imageUrl,
      externalId: candidate.externalId,
      productLink: candidate.productLink,
      itemId: candidate.itemId,
      shopId: candidate.shopId,
      resolvedProductUrl: candidate.resolvedProductUrl,
      originalAffiliateUrl: candidate.originalAffiliateUrl || null,
      asin: candidate.asin,
      status: OFFER_STATUS.READY,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      publishedAt: null,
      createdBy: actorId ?? null,
      source: input.source ?? 'manual',
      discountPercent: calculateDiscount(validation.offer.previousPrice, validation.offer.price),
      couponMatch: input.couponMatch ?? null,
      couponEstimatedPrice: input.couponEstimatedPrice ?? null,
      couponDiscountAmount: input.couponDiscountAmount ?? null,
      couponGuaranteed: Boolean(input.couponGuaranteed)
    };

    if (this.couponService?.associate) {
      try {
        const associated = await this.couponService.associate(offer, { persist: false, actorId });
        if (associated?.offer) {
          offer.coupon = associated.offer.coupon ?? offer.coupon;
          offer.couponConditions = associated.offer.couponConditions ?? offer.couponConditions;
          offer.couponMatch = associated.offer.couponMatch ?? offer.couponMatch;
          offer.couponEstimatedPrice = associated.offer.couponEstimatedPrice ?? null;
          offer.couponDiscountAmount = associated.offer.couponDiscountAmount ?? null;
          offer.couponGuaranteed = Boolean(associated.offer.couponGuaranteed);
        }
      } catch {
        // Cupons indisponíveis não interrompem o cadastro da oferta.
      }
    }

    let rejected = null;
    await this.storage.update((current) => {
      const duplicates = findDuplicates(current.offers, candidate);
      if (duplicates.length) {
        rejected = {
          ok: false,
          duplicate: true,
          duplicates,
          existing: duplicates[0],
          error: duplicateMessage(duplicates)
        };
        return current;
      }
      current.offers.push(offer);
      const seen = new Set(Array.isArray(current.seenOffers) ? current.seenOffers : []);
      for (const key of offerIdentityKeys(offer)) seen.add(key);
      current.seenOffers = [...seen].slice(-5000);
      current.history.push({
        at: nowIso(),
        action: 'create',
        offerId: offer.id,
        actorId: actorId ?? null
      });
      return current;
    });
    if (rejected) return rejected;

    return { ok: true, offer, duplicates: [] };
  }

  async findDuplicatesOf(candidate, { excludeId } = {}) {
    const offers = await this.list();
    return findDuplicates(offers, candidate, { excludeId });
  }

  async saveDraft(input, { actorId } = {}) {
    const validation = validateOfferInput(input, { partial: true });
    const completeness = validateOfferInput(input);
    const offer = {
      id: createOfferId(),
      name: validation.offer.name ?? input.name ?? 'Rascunho sem nome',
      price: validation.offer.price ?? null,
      previousPrice: validation.offer.previousPrice ?? null,
      pixPrice: validation.offer.pixPrice ?? null,
      coupon: validation.offer.coupon ?? null,
      couponConditions: validation.offer.couponConditions ?? null,
      imageUrl: validation.offer.imageUrl ?? null,
      url: validation.offer.url ?? null,
      store: validation.offer.store ?? input.store ?? null,
      validUntil: validation.offer.validUntil ?? null,
      status: OFFER_STATUS.DRAFT,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      publishedAt: null,
      createdBy: actorId ?? null,
      source: input.source ?? 'manual',
      discountPercent: calculateDiscount(validation.offer.previousPrice, validation.offer.price),
      draftErrors: completeness.errors
    };

    await this.storage.update((current) => {
      current.offers.push(offer);
      current.history.push({
        at: nowIso(),
        action: 'draft',
        offerId: offer.id,
        actorId: actorId ?? null
      });
      return current;
    });

    return { ok: true, offer, errors: completeness.errors };
  }

  async update(id, patch, { actorId } = {}) {
    const current = await this.getById(id);
    if (!current) return { ok: false, error: 'Oferta não encontrada.' };
    if (!EDITABLE.has(current.status)) {
      return { ok: false, error: 'Somente rascunhos e ofertas prontas podem ser editados.' };
    }

    const merged = { ...current, ...patch };
    const validation = validateOfferInput(merged);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    const exclusionOptions = await this.exclusionOptions();
    if (isExcludedProduct(validation.offer, exclusionOptions)) {
      return { ok: false, error: exclusionMessage(analyzeExclusion(validation.offer, exclusionOptions).reasons) };
    }

    const next = {
      ...current,
      ...validation.offer,
      status: OFFER_STATUS.READY,
      updatedAt: nowIso(),
      discountPercent: calculateDiscount(validation.offer.previousPrice, validation.offer.price)
    };

    if (this.couponService?.associate) {
      try {
        const associated = await this.couponService.associate(next, { persist: false, actorId });
        if (associated?.offer) {
          next.coupon = associated.offer.coupon ?? next.coupon;
          next.couponConditions = associated.offer.couponConditions ?? next.couponConditions;
          next.couponMatch = associated.offer.couponMatch ?? null;
          next.couponEstimatedPrice = associated.offer.couponEstimatedPrice ?? null;
          next.couponDiscountAmount = associated.offer.couponDiscountAmount ?? null;
          next.couponGuaranteed = Boolean(associated.offer.couponGuaranteed);
        }
      } catch {
        // Cupons indisponíveis não interrompem a edição da oferta.
      }
    }

    let rejected = null;
    await this.storage.update((db) => {
      const duplicates = findDuplicates(db.offers, next, { excludeId: id });
      if (duplicates.length) {
        rejected = {
          ok: false,
          duplicate: true,
          duplicates,
          existing: duplicates[0],
          error: duplicateMessage(duplicates)
        };
        return db;
      }
      db.offers = db.offers.map((item) => (item.id === id ? next : item));
      db.history.push({ at: nowIso(), action: 'update', offerId: id, actorId: actorId ?? null });
      return db;
    });
    if (rejected) return rejected;

    return { ok: true, offer: next };
  }

  async setStatus(id, status, { actorId } = {}) {
    const allowed = Object.values(OFFER_STATUS);
    if (!allowed.includes(status)) return { ok: false, error: 'Estado inválido.' };
    const current = await this.getById(id);
    if (!current) return { ok: false, error: 'Oferta não encontrada.' };

    const next = { ...current, status, updatedAt: nowIso() };
    if (status === OFFER_STATUS.PUBLISHED) next.publishedAt = nowIso();

    await this.storage.update((db) => {
      db.offers = db.offers.map((item) => (item.id === id ? next : item));
      db.history.push({ at: nowIso(), action: 'status', offerId: id, status, actorId: actorId ?? null });
      return db;
    });
    return { ok: true, offer: next };
  }

  async remove(id, { actorId } = {}) {
    const current = await this.getById(id);
    if (!current) return { ok: false, error: 'Oferta não encontrada.' };
    await this.storage.update((db) => {
      db.offers = db.offers.filter((item) => item.id !== id);
      db.history.push({ at: nowIso(), action: 'delete', offerId: id, actorId: actorId ?? null });
      return db;
    });
    return { ok: true, offer: current };
  }

  async markPublished(id, extra = {}) {
    return this.setStatus(id, OFFER_STATUS.PUBLISHED, extra);
  }

  async history(limit = 20) {
    const db = await this.storage.read();
    return db.history.slice(-limit).reverse();
  }

  async operationalStatus() {
    const offers = await this.list();
    const count = (status) => offers.filter((item) => item.status === status).length;
    return {
      total: offers.length,
      rascunho: count(OFFER_STATUS.DRAFT),
      pronta: count(OFFER_STATUS.READY),
      publicada: count(OFFER_STATUS.PUBLISHED),
      expirada: count(OFFER_STATUS.EXPIRED),
      cancelada: count(OFFER_STATUS.CANCELLED)
    };
  }

  async seenKeys() {
    const db = await this.storage.read();
    const keys = new Set();
    for (const key of db.seenOffers || []) {
      for (const item of offerIdentityKeys({ externalId: key, url: key, productLink: key })) {
        keys.add(item);
      }
      if (key) keys.add(String(key));
    }
    for (const offer of db.offers || []) {
      if (offer.status === OFFER_STATUS.CANCELLED) continue;
      for (const key of offerIdentityKeys(offer)) keys.add(key);
    }
    return keys;
  }

  async recordAutomationRun(summary = {}) {
    const seenKeys = Array.isArray(summary.seenKeys) ? summary.seenKeys.map((item) => String(item)).filter(Boolean) : [];
    const record = {
      at: nowIso(),
      fetched: summary.fetched ?? 0,
      imported: summary.imported ?? 0,
      published: summary.published ?? 0,
      selected: summary.selected ?? 0,
      duplicates: summary.duplicates ?? 0,
      rejected: summary.rejected ?? 0,
      excludedBooks: summary.excludedBooks ?? 0,
      note: summary.note ?? null
    };
    await this.storage.update((db) => {
      const seen = new Set(Array.isArray(db.seenOffers) ? db.seenOffers : []);
      for (const key of seenKeys) seen.add(key);
      db.seenOffers = [...seen].slice(-5000);
      db.settings = { ...db.settings, lastAutomationRun: record };
      db.history.push({
        at: record.at,
        action: 'automation-run',
        actorId: 'scheduler',
        fetched: record.fetched,
        imported: record.imported,
        published: record.published
      });
      return db;
    });
    return record;
  }
}

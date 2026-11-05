import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { detectPlatform } from './link-extractor.js';
import { formatBRL, roundMoney } from './validation-service.js';

export const COUPON_STATUS = {
  ACTIVE: 'ativo',
  INACTIVE: 'inativo',
  EXPIRED: 'expirado',
  SCHEDULED: 'agendado'
};

const MARKETPLACE_ALIASES = {
  shopee: ['shopee', 'shopee.com.br', 'shope.ee'],
  mercadolivre: ['mercado livre', 'mercado libre', 'mercadolivre', 'mercadolibre', 'meli'],
  amazon: ['amazon', 'amazon brasil', 'amazon.com.br']
};

function nowIso(date = new Date()) {
  return date.toISOString();
}

function asText(value, max = 200) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniqueList(values, max = 40) {
  const seen = new Set();
  const result = [];
  for (const item of values || []) {
    const text = asText(item, 120);
    if (!text) continue;
    const key = normalizeKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

function listHas(list, candidate) {
  const target = normalizeKey(candidate);
  if (!target) return false;
  return list.some((item) => {
    const key = normalizeKey(item);
    return key === target || key.includes(target) || target.includes(key);
  });
}

export function createCouponId() {
  return crypto.randomBytes(6).toString('hex');
}

export function couponFingerprint(coupon) {
  const code = normalizeKey(coupon?.code);
  const marketplace = normalizeKey(coupon?.marketplace);
  const store = normalizeKey(coupon?.store);
  const source = normalizeKey(coupon?.source);
  return `${code}|${marketplace}|${store}|${source}`;
}

export function normalizeMarketplace(value, url) {
  const raw = normalizeKey(value);
  if (raw) {
    for (const [id, aliases] of Object.entries(MARKETPLACE_ALIASES)) {
      if (aliases.some((alias) => raw === alias || raw.includes(alias))) return id;
    }
  }
  const platform = detectPlatform(url);
  if (platform?.id && platform.id !== 'generic') return platform.id;
  return raw || null;
}

export function couponStatusAt(coupon, at = new Date()) {
  if (coupon?.enabled === false) return COUPON_STATUS.INACTIVE;
  const start = coupon?.startsAt ? new Date(coupon.startsAt) : null;
  const end = coupon?.expiresAt ? new Date(coupon.expiresAt) : null;
  const now = at instanceof Date ? at : new Date(at);
  if (start && !Number.isNaN(start.getTime()) && start.getTime() > now.getTime()) {
    return COUPON_STATUS.SCHEDULED;
  }
  if (end && !Number.isNaN(end.getTime()) && end.getTime() < now.getTime()) {
    return COUPON_STATUS.EXPIRED;
  }
  return COUPON_STATUS.ACTIVE;
}

export function normalizeCoupon(raw = {}, extras = {}) {
  const code = asText(raw.code ?? raw.coupon, 80);
  if (!code) return null;
  const type = String(raw.type ?? raw.discountType ?? '').toLowerCase() === 'fixed' ? 'fixed' : 'percent';
  const value = asNumber(raw.value ?? raw.discountValue ?? raw.percent ?? raw.amount);
  const marketplace = normalizeMarketplace(raw.marketplace ?? raw.platform, extras.url || raw.url);
  return {
    id: asText(raw.id, 32) || createCouponId(),
    code: code.toUpperCase(),
    type,
    value: value != null && value >= 0 ? roundMoney(value) : null,
    maxDiscount: asNumber(raw.maxDiscount ?? raw.maxDiscountAmount),
    minPurchase: asNumber(raw.minPurchase ?? raw.minValue ?? raw.minimum),
    marketplace,
    store: asText(raw.store ?? raw.seller ?? raw.shop, 80),
    categories: uniqueList(raw.categories ?? raw.category ? [].concat(raw.categories ?? raw.category) : []),
    products: uniqueList(raw.products ?? raw.productIds ?? raw.skus),
    firstPurchaseOnly: Boolean(raw.firstPurchaseOnly ?? raw.firstPurchase),
    stackable: Boolean(raw.stackable),
    startsAt: asDate(raw.startsAt ?? raw.startAt ?? raw.validFrom),
    expiresAt: asDate(raw.expiresAt ?? raw.validUntil ?? raw.endsAt),
    conditions: asText(raw.conditions ?? raw.couponConditions ?? raw.notes, 300),
    source: asText(raw.source ?? extras.source, 40) || 'catalog',
    enabled: raw.enabled !== false,
    createdAt: asDate(raw.createdAt) || nowIso(),
    updatedAt: asDate(raw.updatedAt) || nowIso()
  };
}

export function calculateCouponDiscount(coupon, price) {
  if (price == null || !Number.isFinite(Number(price)) || Number(price) < 0) {
    return { ok: false, reason: 'preco-ausente' };
  }
  const current = roundMoney(price);
  if (coupon?.type === 'fixed') {
    if (coupon.value == null || coupon.value <= 0) return { ok: false, reason: 'valor-ausente' };
    const amount = roundMoney(Math.min(coupon.value, current));
    return {
      ok: true,
      amount,
      finalPrice: roundMoney(Math.max(0, current - amount)),
      estimated: true
    };
  }
  if (coupon?.type === 'percent') {
    if (coupon.value == null || coupon.value <= 0) return { ok: false, reason: 'valor-ausente' };
    let amount = roundMoney((current * coupon.value) / 100);
    if (coupon.maxDiscount != null && coupon.maxDiscount > 0) {
      amount = roundMoney(Math.min(amount, coupon.maxDiscount));
    }
    amount = roundMoney(Math.min(amount, current));
    return {
      ok: true,
      amount,
      finalPrice: roundMoney(Math.max(0, current - amount)),
      estimated: true
    };
  }
  return { ok: false, reason: 'tipo-desconhecido' };
}

export function evaluateCouponEligibility(coupon, product = {}, at = new Date()) {
  const reasons = [];
  if (!coupon?.code) return { eligible: false, reasons: ['codigo-ausente'] };

  const status = couponStatusAt(coupon, at);
  if (status === COUPON_STATUS.INACTIVE) reasons.push('inativo');
  if (status === COUPON_STATUS.EXPIRED) reasons.push('expirado');
  if (status === COUPON_STATUS.SCHEDULED) reasons.push('inicio-futuro');

  const productMarketplace = normalizeMarketplace(product.marketplace || product.platform, product.url);
  if (coupon.marketplace && productMarketplace && coupon.marketplace !== productMarketplace) {
    reasons.push('marketplace-incompativel');
  }

  if (coupon.store) {
    const store = product.store || product.seller || product.shop;
    if (!store || !listHas([coupon.store], store)) reasons.push('vendedor-incompativel');
  }

  if (coupon.categories?.length) {
    const category = product.category;
    if (!category || !listHas(coupon.categories, category)) reasons.push('categoria-incompativel');
  }

  if (coupon.products?.length) {
    const ids = [product.externalId, product.sku, product.asin, product.name].filter(Boolean);
    const matched = ids.some((id) => listHas(coupon.products, id));
    if (!matched) reasons.push('produto-incompativel');
  }

  if (coupon.minPurchase != null && coupon.minPurchase > 0) {
    if (product.price == null) reasons.push('preco-ausente');
    else if (Number(product.price) < coupon.minPurchase) reasons.push('abaixo-do-minimo');
  }

  const discount = calculateCouponDiscount(coupon, product.price);
  const eligible = reasons.length === 0;
  return {
    eligible,
    guaranteed: eligible && !coupon.firstPurchaseOnly,
    status,
    reasons: coupon.firstPurchaseOnly ? [...reasons, 'primeira-compra'] : reasons,
    discount: discount.ok ? discount : null
  };
}

export function selectBestCoupon(coupons, product, at = new Date()) {
  const evaluated = [];
  for (const coupon of coupons || []) {
    const evaluation = evaluateCouponEligibility(coupon, product, at);
    evaluated.push({ coupon, evaluation });
  }
  const eligible = evaluated.filter((item) => item.evaluation.eligible);
  eligible.sort((a, b) => {
    const amountA = a.evaluation.discount?.amount ?? -1;
    const amountB = b.evaluation.discount?.amount ?? -1;
    if (amountB !== amountA) return amountB - amountA;
    const endA = a.coupon.expiresAt ? new Date(a.coupon.expiresAt).getTime() : Number.POSITIVE_INFINITY;
    const endB = b.coupon.expiresAt ? new Date(b.coupon.expiresAt).getTime() : Number.POSITIVE_INFINITY;
    return endA - endB;
  });
  const best = eligible[0] || null;
  return {
    coupon: best?.coupon || null,
    evaluation: best?.evaluation || null,
    candidates: evaluated,
    skipped: evaluated.filter((item) => !item.evaluation.eligible)
  };
}

export function applyCouponToOffer(offer, selection) {
  if (!offer) return offer;
  const coupon = selection?.coupon;
  if (!coupon || !selection?.evaluation?.eligible) {
    return {
      ...offer,
      couponMatch: null,
      couponEstimatedPrice: null,
      couponDiscountAmount: null,
      couponGuaranteed: false
    };
  }
  const discount = selection.evaluation.discount;
  const conditions = [coupon.conditions].filter(Boolean);
  if (coupon.minPurchase != null) conditions.push(`Pedido mínimo R$ ${formatBRL(coupon.minPurchase)}`);
  if (coupon.firstPurchaseOnly) conditions.push('Sujeito a primeira compra');
  if (discount && !selection.evaluation.guaranteed) {
    conditions.push('Preço final estimado; depende da conta');
  }
  const next = {
    ...offer,
    coupon: coupon.code,
    couponConditions: conditions.join('. ') || offer.couponConditions || null,
    couponMatch: {
      id: coupon.id,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      source: coupon.source,
      guaranteed: Boolean(selection.evaluation.guaranteed)
    },
    couponEstimatedPrice: discount?.finalPrice ?? null,
    couponDiscountAmount: discount?.amount ?? null,
    couponGuaranteed: Boolean(selection.evaluation.guaranteed)
  };
  return next;
}

export function describeCouponAssociation(offer) {
  if (!offer?.coupon) return null;
  const parts = [`Cupom ${offer.coupon}`];
  if (offer.couponDiscountAmount != null) parts.push(`desconto R$ ${formatBRL(offer.couponDiscountAmount)}`);
  if (offer.couponEstimatedPrice != null) {
    const label = offer.couponGuaranteed ? 'preço com cupom' : 'preço estimado com cupom';
    parts.push(`${label} R$ ${formatBRL(offer.couponEstimatedPrice)}`);
  }
  return parts.join(' — ');
}

export class CouponService {
  constructor(storage, { sources = [] } = {}) {
    this.storage = storage;
    this.sources = sources;
  }

  async list() {
    if (!this.storage) return [];
    const db = await this.storage.read();
    return Array.isArray(db.coupons) ? db.coupons : [];
  }

  async upsertMany(rawCoupons, { actorId, source } = {}) {
    const incoming = [];
    for (const raw of rawCoupons || []) {
      const coupon = normalizeCoupon(raw, { source });
      if (coupon) incoming.push(coupon);
    }
    if (!this.storage) return { ok: true, upserted: incoming.length, coupons: incoming };
    const result = await this.storage.update((db) => {
      const current = Array.isArray(db.coupons) ? db.coupons : [];
      const byFingerprint = new Map(current.map((item) => [couponFingerprint(item), item]));
      let upserted = 0;
      for (const coupon of incoming) {
        const key = couponFingerprint(coupon);
        const previous = byFingerprint.get(key);
        const next = previous
          ? { ...previous, ...coupon, id: previous.id, createdAt: previous.createdAt, updatedAt: nowIso() }
          : coupon;
        byFingerprint.set(key, next);
        upserted += 1;
      }
      db.coupons = [...byFingerprint.values()];
      db.history.push({
        at: nowIso(),
        action: 'coupons-upsert',
        actorId: actorId ?? null,
        count: upserted
      });
      return db;
    });
    return { ok: true, upserted: incoming.length, coupons: result.coupons };
  }

  async refreshFromSources({ actorId } = {}) {
    const collected = [];
    const errors = [];
    for (const source of this.sources) {
      try {
        const result = typeof source.fetchCoupons === 'function'
          ? await source.fetchCoupons()
          : { ok: true, coupons: [] };
        if (!result?.ok) {
          errors.push({ source: source.name || 'coupon-source', reason: result?.reason || 'source-error' });
          continue;
        }
        collected.push(...(result.coupons || []).map((item) => ({ ...item, source: item.source || source.name })));
      } catch (error) {
        logger.warn('Falha ao consultar fonte de cupons.', error.message);
        errors.push({ source: source.name || 'coupon-source', reason: 'exception' });
      }
    }
    const stored = await this.upsertMany(collected, { actorId, source: 'source' });
    await this.expireStale({ actorId });
    return { ok: true, fetched: collected.length, stored: stored.upserted, errors };
  }

  async expireStale({ actorId, at = new Date() } = {}) {
    if (!this.storage) return { ok: true, expired: 0 };
    let expired = 0;
    await this.storage.update((db) => {
      const coupons = Array.isArray(db.coupons) ? db.coupons : [];
      db.coupons = coupons.map((coupon) => {
        if (couponStatusAt(coupon, at) !== COUPON_STATUS.EXPIRED || coupon.enabled === false) return coupon;
        expired += 1;
        return { ...coupon, enabled: false, updatedAt: nowIso(at) };
      });
      if (expired) {
        db.history.push({ at: nowIso(at), action: 'coupons-expire', actorId: actorId ?? null, count: expired });
      }
      return db;
    });
    return { ok: true, expired };
  }

  async associate(product, { persist = true, actorId, at = new Date() } = {}) {
    const enriched = {
      ...product,
      marketplace: product?.marketplace || normalizeMarketplace(product?.store, product?.url)
    };
    let coupons = [];
    try {
      coupons = await this.list();
    } catch (error) {
      logger.warn('Falha ao ler cupons. A oferta segue sem associação.', error.message);
      return { ok: true, offer: product, coupon: null, skipped: true, reason: 'storage-error' };
    }

    const existingCode = asText(enriched.coupon, 80);
    let selection;
    if (existingCode) {
      const same = coupons.find((item) => item.code === existingCode.toUpperCase());
      if (same) {
        const evaluation = evaluateCouponEligibility(same, enriched, at);
        selection = evaluation.eligible
          ? { coupon: same, evaluation, skipped: [] }
          : { coupon: null, evaluation, skipped: [{ coupon: same, evaluation }] };
      } else {
        selection = { coupon: null, evaluation: null, skipped: [] };
      }
    } else {
      selection = selectBestCoupon(coupons, enriched, at);
    }

    const offer = existingCode && !selection.coupon
      ? {
          ...enriched,
          coupon: existingCode.toUpperCase(),
          couponMatch: null,
          couponEstimatedPrice: null,
          couponDiscountAmount: null,
          couponGuaranteed: false
        }
      : applyCouponToOffer(enriched, selection);

    if (persist && this.storage && selection.coupon && product?.id) {
      await this.storage.update((db) => {
        db.history.push({
          at: nowIso(at),
          action: 'coupon-associate',
          offerId: product.id,
          couponId: selection.coupon.id,
          actorId: actorId ?? null
        });
        return db;
      }).catch((error) => logger.warn('Falha ao registrar associação de cupom.', error.message));
    }
    return {
      ok: true,
      offer,
      coupon: selection.coupon,
      evaluation: selection.evaluation,
      skipped: selection.skipped
    };
  }
}

export function extractFeedCoupons(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.coupons)) return payload.coupons;
  return [];
}

export function couponFromOfferFields(offer, extras = {}) {
  if (!offer?.coupon) return null;
  return normalizeCoupon(
    {
      code: offer.coupon,
      conditions: offer.couponConditions,
      marketplace: extras.marketplace || offer.store,
      store: extras.restrictStore ? offer.store : null,
      source: extras.source || offer.source || 'offer'
    },
    extras
  );
}

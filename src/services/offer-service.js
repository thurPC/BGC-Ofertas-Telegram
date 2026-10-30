import crypto from 'node:crypto';
import { calculateDiscount, validateOfferInput } from './validation-service.js';

export const OFFER_STATUS = {
  DRAFT: 'rascunho',
  READY: 'pronta',
  PUBLISHED: 'publicada',
  EXPIRED: 'expirada',
  CANCELLED: 'cancelada'
};

const EDITABLE = new Set([OFFER_STATUS.DRAFT, OFFER_STATUS.READY]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function createOfferId() {
  return crypto.randomBytes(6).toString('hex');
}

export function fingerprint(offer) {
  const name = normalizeKey(offer.name);
  const url = String(offer.url ?? '').trim().toLowerCase();
  const store = normalizeKey(offer.store);
  const price = offer.price != null ? String(offer.price) : '';
  return `${name}|${store}|${url}|${price}`;
}

export function findDuplicates(offers, candidate, { excludeId } = {}) {
  const target = fingerprint(candidate);
  const name = normalizeKey(candidate.name);
  const url = String(candidate.url ?? '').trim().toLowerCase();
  const externalId = String(candidate.externalId ?? '').trim();
  return offers.filter((offer) => {
    if (excludeId && offer.id === excludeId) return false;
    if ([OFFER_STATUS.CANCELLED, OFFER_STATUS.EXPIRED].includes(offer.status)) return false;
    if (externalId && String(offer.externalId ?? '').trim() === externalId) return true;
    if (fingerprint(offer) === target) return true;
    if (url && String(offer.url ?? '').trim().toLowerCase() === url) return true;
    if (name && normalizeKey(offer.name) === name && normalizeKey(offer.store) === normalizeKey(candidate.store)) {
      return true;
    }
    return false;
  });
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
  constructor(storage) {
    this.storage = storage;
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

    const db = await this.storage.read();
    const duplicates = findDuplicates(db.offers, validation.offer);
    const offer = {
      id: createOfferId(),
      ...validation.offer,
      url: input.url || validation.offer.url,
      imageUrl: input.imageUrl || validation.offer.imageUrl || null,
      imageFileId: input.imageFileId ?? validation.offer.imageFileId ?? null,
      externalId: input.externalId ?? null,
      status: OFFER_STATUS.READY,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      publishedAt: null,
      createdBy: actorId ?? null,
      source: input.source ?? 'manual',
      discountPercent: calculateDiscount(validation.offer.previousPrice, validation.offer.price)
    };

    await this.storage.update((current) => {
      current.offers.push(offer);
      current.history.push({
        at: nowIso(),
        action: 'create',
        offerId: offer.id,
        actorId: actorId ?? null
      });
      return current;
    });

    return { ok: true, offer, duplicates };
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
      imageFileId: validation.offer.imageFileId ?? input.imageFileId ?? null,
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

    const next = {
      ...current,
      ...validation.offer,
      status: OFFER_STATUS.READY,
      updatedAt: nowIso(),
      discountPercent: calculateDiscount(validation.offer.previousPrice, validation.offer.price)
    };

    await this.storage.update((db) => {
      db.offers = db.offers.map((item) => (item.id === id ? next : item));
      db.history.push({ at: nowIso(), action: 'update', offerId: id, actorId: actorId ?? null });
      return db;
    });

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
}

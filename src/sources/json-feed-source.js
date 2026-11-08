import { OfferSource, normalizeFetchedOffer } from './source-interface.js';
import { logger } from '../logger.js';
import {
  analyzeExclusion,
  exclusionMessage,
  isExcludedProduct
} from '../services/exclusion-filter.js';
import { couponFromOfferFields, extractFeedCoupons, normalizeCoupon } from '../services/coupon-service.js';
import { calculateDiscount, validateOfferInput } from '../services/validation-service.js';
import { ShopeeOfferSource } from './shopee-offer-source.js';
import {
  classifyFetchError,
  defaultJsonHeaders,
  describeNetworkError,
  isRetryableHttpStatus,
  sleep
} from '../http.js';

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 400;

export function extractFeedItems(payload) {
  if (Array.isArray(payload)) return { ok: true, items: payload };
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.offers)) return { ok: true, items: payload.offers };
    if (Array.isArray(payload.items)) return { ok: true, items: payload.items };
  }
  return {
    ok: false,
    items: [],
    error: 'Estrutura JSON inválida: esperado um array ou um objeto com as chaves offers ou items.'
  };
}

export function parseFeedPayload(payload, sourceName = 'json-feed') {
  const extracted = extractFeedItems(payload);
  if (!extracted.ok) {
    return {
      ok: false,
      offers: [],
      coupons: [],
      errors: [extracted.error],
      reason: 'invalid-structure',
      skipped: 0
    };
  }

  const offers = [];
  const coupons = [];
  const errors = [];
  let skipped = 0;

  extracted.items.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skipped += 1;
      errors.push({ index, errors: ['Item do feed não é um objeto.'] });
      return;
    }

    const normalized = normalizeFetchedOffer(item, item.store || sourceName);
    if (isExcludedProduct(normalized)) {
      skipped += 1;
      errors.push({
        index,
        name: normalized.name,
        errors: [exclusionMessage(analyzeExclusion(normalized).reasons)]
      });
      logger.info('Item de livro/publicação ignorado no parse do feed.', {
        name: normalized.name,
        reasons: analyzeExclusion(normalized).reasons
      });
      return;
    }
    const validation = validateOfferInput(normalized);
    if (!validation.ok) {
      skipped += 1;
      errors.push({
        index,
        name: normalized.name,
        errors: validation.errors
      });
      return;
    }

    offers.push({
      ...validation.offer,
      url: normalized.url || validation.offer.url,
      imageUrl: normalized.imageUrl || validation.offer.imageUrl,
      externalId: normalized.externalId,
      marketplace: normalized.marketplace,
      description: normalized.description,
      source: sourceName,
      fetchedAt: normalized.fetchedAt,
      discountPercent: calculateDiscount(validation.offer.previousPrice, validation.offer.price)
    });
    const fromOffer = couponFromOfferFields(normalized, { source: sourceName });
    if (fromOffer) coupons.push(fromOffer);
  });

  for (const raw of extractFeedCoupons(payload)) {
    const coupon = normalizeCoupon(raw, { source: sourceName });
    if (coupon) coupons.push(coupon);
  }

  return { ok: true, offers, coupons, errors, skipped, reason: null };
}

export class JsonFeedSource extends OfferSource {
  constructor(feedUrl, options = {}) {
    super('json-feed');
    this.feedUrl = String(feedUrl ?? '').trim();
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0
      ? options.maxRetries
      : DEFAULT_MAX_RETRIES;
    this.retryBaseMs = Number.isFinite(options.retryBaseMs) && options.retryBaseMs >= 0
      ? options.retryBaseMs
      : DEFAULT_RETRY_BASE_MS;
  }

  isConfigured() {
    return /^https?:\/\//i.test(this.feedUrl);
  }

  describe() {
    return {
      name: this.name,
      configured: this.isConfigured(),
      note: this.isConfigured()
        ? 'Feed JSON autorizado configurado. A publicação automática permanece desativada até o administrador habilitar.'
        : 'Nenhuma fonte automática configurada. O modo manual continua disponível.'
    };
  }

  async fetchOffers() {
    const result = await this.fetch();
    return result.offers;
  }

  async fetch() {
    if (!this.isConfigured()) {
      return {
        ok: true,
        offers: [],
        coupons: [],
        errors: [],
        skipped: 0,
        reason: 'not-configured',
        status: null
      };
    }
    if (typeof this.fetchImpl !== 'function') {
      logger.warn('Fetch HTTP indisponível para o feed JSON.');
      return {
        ok: false,
        offers: [],
        coupons: [],
        errors: ['Cliente HTTP indisponível.'],
        skipped: 0,
        reason: 'network',
        status: null
      };
    }

    const attempts = this.maxRetries + 1;
    let last = {
      ok: false,
      offers: [],
      coupons: [],
      errors: ['Falha de rede ao consultar o feed.'],
      skipped: 0,
      reason: 'network',
      status: null
    };

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryBaseMs * 2 ** (attempt - 1));
      }
      last = await this.#send();
      if (last.ok) return last;
      const retryable =
        last.reason === 'timeout' ||
        last.reason === 'network' ||
        (last.reason === 'http-error' && isRetryableHttpStatus(last.status));
      if (!retryable) {
        this.#logFailure(last);
        return last;
      }
    }
    this.#logFailure(last);
    return last;
  }

  #logFailure(result) {
    if (result?.reason === 'http-error') {
      logger.warn(`Feed JSON retornou HTTP ${result.status}.`);
      return;
    }
    if (result?.reason === 'invalid-json') {
      logger.warn('Feed JSON retornou conteúdo que não é JSON válido.');
      return;
    }
    logger.warn(
      'Falha ao consultar feed JSON autorizado.',
      result.detail || result.errors?.[0] || result.reason || 'erro'
    );
  }

  async #send() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.feedUrl, {
        signal: controller.signal,
        headers: defaultJsonHeaders()
      });
      if (!response.ok) {
        return {
          ok: false,
          offers: [],
          coupons: [],
          errors: [`HTTP ${response.status}`],
          skipped: 0,
          reason: 'http-error',
          status: response.status
        };
      }

      const rawText = await response.text();
      if (!String(rawText).trim()) {
        return {
          ok: false,
          offers: [],
          coupons: [],
          errors: ['Resposta vazia do feed JSON.'],
          skipped: 0,
          reason: 'invalid-json',
          status: response.status
        };
      }

      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch {
        return {
          ok: false,
          offers: [],
          coupons: [],
          errors: ['JSON inválido.'],
          skipped: 0,
          reason: 'invalid-json',
          status: response.status
        };
      }

      const parsed = parseFeedPayload(payload, this.name);
      return { ...parsed, status: response.status };
    } catch (error) {
      const reason = classifyFetchError(error);
      const detail = describeNetworkError(error);
      return {
        ok: false,
        offers: [],
        coupons: [],
        errors: [reason === 'timeout' ? 'Tempo esgotado ao consultar o feed.' : 'Falha de rede ao consultar o feed.'],
        skipped: 0,
        reason,
        status: null,
        detail
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createConfiguredSources(config, options = {}) {
  const sources = [];
  if (config.feedUrl) sources.push(new JsonFeedSource(config.feedUrl, options));
  if (config.shopeeAppId && config.shopeeAppSecret) {
    sources.push(
      new ShopeeOfferSource({
        appId: config.shopeeAppId,
        secret: config.shopeeAppSecret,
        endpoint: config.shopeeApiUrl,
        fetchImpl: options.fetchImpl,
        client: options.shopeeClient,
        keywords: config.shopeeKeywords,
        limit: options.shopeeLimit,
        maxPages: options.shopeeMaxPages,
        pageDelayMs: options.shopeePageDelayMs,
        clockSkewSeconds: config.shopeeClockSkewSeconds
      })
    );
  }
  return sources;
}

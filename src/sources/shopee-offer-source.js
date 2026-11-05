import { OfferSource, normalizeFetchedOffer } from './source-interface.js';
import { logger } from '../logger.js';
import { calculateDiscount } from '../services/validation-service.js';
import {
  ShopeeAffiliateClient,
  isShopeeAffiliateUrl
} from '../services/shopee-affiliate-client.js';
import { DEFAULT_CATEGORIES, detectCategory } from '../services/offer-scorer.js';
import { offerIdentityKeys } from '../services/offer-identity.js';

export const SHOPEE_CATEGORY_KEYWORDS = Object.fromEntries(
  DEFAULT_CATEGORIES.map((category) => [category.id, category.keywords])
);

function flattenKeywords(categories = DEFAULT_CATEGORIES, extra = []) {
  const extras = extra
    .map((keyword) => String(keyword).trim())
    .filter(Boolean)
    .map((keyword) => ({ keyword, category: detectCategory({ name: keyword }) }));
  const fromCategories = (categories || []).map((category) => ({
    keyword: category.keywords[0],
    category: category.id
  }));
  const source = extras.length ? extras : fromCategories;
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const key = String(item.keyword || '').trim();
    if (!key || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    result.push({ keyword: key, category: item.category || null });
  }
  return result;
}

export class ShopeeOfferSource extends OfferSource {
  constructor(options = {}) {
    super('shopee-open-api');
    this.client = options.client || new ShopeeAffiliateClient(options);
    this.limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(50, options.limit) : 20;
    this.maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0 ? Math.min(5, options.maxPages) : 1;
    this.pageDelayMs = Number.isFinite(options.pageDelayMs) && options.pageDelayMs >= 0 ? options.pageDelayMs : 200;
    this.keywordDelayMs = Number.isFinite(options.keywordDelayMs) && options.keywordDelayMs >= 0 ? options.keywordDelayMs : 150;
    this.keywords = flattenKeywords(options.categories || DEFAULT_CATEGORIES, options.keywords || []);
  }

  applySearchOptions({ categories, keywords } = {}) {
    const extras = Array.isArray(keywords) ? keywords : [];
    this.keywords = extras.length
      ? flattenKeywords([], extras)
      : flattenKeywords(categories || DEFAULT_CATEGORIES, []);
  }

  isConfigured() {
    return this.client.isConfigured();
  }

  describe() {
    return {
      name: this.name,
      configured: this.isConfigured(),
      note: this.isConfigured()
        ? 'Shopee Affiliate Open API configurada; busca automática por categorias.'
        : 'Configure SHOPEE_APP_ID e SHOPEE_APP_SECRET no ambiente.'
    };
  }

  async queryKeyword(keyword, category) {
    const offers = [];
    let page = 1;
    let hasNext = true;
    while (hasNext && page <= this.maxPages) {
      const result = await this.client.searchProducts(keyword, {
        page,
        limit: this.limit,
        sortType: 1,
        listType: 0,
        category
      });
      if (!result.ok) {
        return { ok: false, reason: result.reason, error: result.error, code: result.code, offers };
      }
      for (const product of result.products) {
        const mapped = this.#toOffer(product, category);
        if (mapped) offers.push(mapped);
      }
      hasNext = Boolean(result.pageInfo?.hasNextPage);
      page += 1;
      if (hasNext && page <= this.maxPages && this.pageDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.pageDelayMs));
      }
    }
    return { ok: true, offers };
  }

  #toOffer(product, category) {
    if (!product?.name || product.price == null) return null;
    if (!product.url || !isShopeeAffiliateUrl(product.url)) return null;
    const normalized = normalizeFetchedOffer(
      {
        id: product.externalId,
        name: product.name,
        price: product.price,
        previousPrice: product.previousPrice,
        imageUrl: product.imageUrl,
        url: product.url,
        store: product.store || 'Shopee',
        validUntil: product.validUntil,
        description: product.description
      },
      'Shopee'
    );
    return {
      ...normalized,
      externalId: product.externalId,
      productLink: product.productLink || null,
      itemId: product.itemId || null,
      shopId: product.shopId || null,
      source: this.name,
      category: product.category || category || detectCategory(normalized),
      commissionRate: product.commissionRate,
      commission: product.commission,
      sales: product.sales,
      ratingStar: product.ratingStar,
      priceDiscountRate: product.priceDiscountRate,
      discountPercent: calculateDiscount(normalized.previousPrice, normalized.price)
    };
  }

  async fetch() {
    if (!this.isConfigured()) {
      return {
        ok: false,
        offers: [],
        errors: ['Shopee não configurada.'],
        skipped: 0,
        reason: 'not-configured'
      };
    }

    const offers = [];
    const errors = [];
    for (const item of this.keywords) {
      const result = await this.queryKeyword(item.keyword, item.category);
      if (!result.ok) {
        logger.warn(
          'Falha ao consultar ofertas da Shopee.',
          result.reason || 'erro',
          result.error || '',
          result.code != null ? `code=${result.code}` : ''
        );
        errors.push({
          keyword: item.keyword,
          reason: result.reason,
          error: result.error,
          code: result.code ?? null
        });
        if (result.reason === 'auth-error' || result.reason === 'system-error') break;
        continue;
      }
      offers.push(...result.offers);
      if (this.keywordDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.keywordDelayMs));
      }
    }

    const unique = new Map();
    const seen = new Set();
    for (const offer of offers) {
      const keys = offerIdentityKeys(offer);
      if (keys.some((key) => seen.has(key))) continue;
      const key = keys[0] || String(offer.url || '').toLowerCase();
      if (!key || unique.has(key)) continue;
      for (const item of keys) seen.add(item);
      unique.set(key, offer);
    }

    return {
      ok: true,
      offers: [...unique.values()],
      errors,
      skipped: 0,
      reason: errors.length && unique.size === 0 ? errors[0].reason : null
    };
  }

  async fetchOffers() {
    const result = await this.fetch();
    return result.offers;
  }
}

export { DEFAULT_CATEGORIES as SHOPEE_SEARCH_CATEGORIES };

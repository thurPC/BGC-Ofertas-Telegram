import { createHash } from 'node:crypto';
import { OfferSource, normalizeFetchedOffer } from './source-interface.js';
import { logger } from '../logger.js';
import { calculateDiscount } from '../services/validation-service.js';

const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';
const SEARCH_TERMS = [
  'tecnologia',
  'informática',
  'periféricos',
  'games',
  'acessórios gamer',
  'eletrônicos',
  'casa',
  'utilidades domésticas'
];
const LIMIT = 20;
const TIMEOUT_MS = 15000;

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function productPrice(node) {
  // A API retorna priceMin/priceMax. Não publicar preço se o campo vier ausente.
  return safeNumber(node.priceMin);
}

function normalizeProduct(node) {
  const price = productPrice(node);
  const discount = safeNumber(node.priceDiscountRate);
  const previousPrice = price !== null && discount !== null && discount > 0 && discount < 100
    ? Math.round((price / (1 - discount / 100) + Number.EPSILON) * 100) / 100
    : null;
  const id = String(node.itemId ?? node.productId ?? '').trim();
  const shopId = String(node.shopId ?? '').trim();
  return normalizeFetchedOffer({
    id: id && shopId ? `shopee:${shopId}:${id}` : id ? `shopee:${id}` : null,
    name: node.productName,
    price,
    previousPrice,
    imageUrl: node.imageUrl,
    url: node.offerLink,
    store: node.shopName || 'Shopee'
  }, 'Shopee');
}

export class ShopeeOfferSource extends OfferSource {
  constructor({ appId, secret, endpoint = ENDPOINT, fetchImpl, timeoutMs = TIMEOUT_MS, keywords = SEARCH_TERMS } = {}) {
    super('shopee-open-api');
    this.appId = String(appId ?? '').trim();
    this.secret = String(secret ?? '').trim();
    this.endpoint = String(endpoint ?? ENDPOINT).trim();
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.keywords = [...new Set((keywords || SEARCH_TERMS).map((x) => String(x).trim()).filter(Boolean))];
  }

  isConfigured() {
    return Boolean(this.appId && this.secret && typeof this.fetchImpl === 'function');
  }

  describe() {
    return {
      name: this.name,
      configured: this.isConfigured(),
      note: this.isConfigured()
        ? 'Shopee Affiliate Open API configurada; consultas de produtos por palavras-chave.'
        : 'Configure SHOPEE_APP_ID e SHOPEE_APP_SECRET no ambiente.'
    };
  }

  authorization(body, timestamp) {
    const signature = createHash('sha256')
      .update(this.appId + String(timestamp) + body + this.secret, 'utf8')
      .digest('hex');
    return `SHA256 Credential=${this.appId}, Timestamp=${timestamp}, Signature=${signature}`;
  }

  async queryProducts(keyword) {
    const query = `query { productOfferV2(keyword: ${JSON.stringify(keyword)}, listType: 0, sortType: 1, page: 1, limit: ${LIMIT}) { nodes { itemId productName productLink offerLink imageUrl priceMin priceMax priceDiscountRate sales ratingStar commissionRate shopId shopName periodEndTime } pageInfo { page limit hasNextPage } } }`;
    const body = JSON.stringify({ query });
    const timestamp = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: this.authorization(body, timestamp),
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body
      });
      if (!response.ok) return { ok: false, reason: `http-${response.status}` };
      const payload = await response.json();
      if (payload.errors?.length) {
        logger.warn('Shopee GraphQL retornou erro.', String(payload.errors[0]?.message || 'erro GraphQL'));
        return { ok: false, reason: 'graphql-error' };
      }
      const nodes = payload.data?.productOfferV2?.nodes;
      if (!Array.isArray(nodes)) return { ok: false, reason: 'invalid-response' };
      return { ok: true, offers: nodes.map((node) => {\n        const item = normalizeProduct(node);\n        return { ...item, discountPercent: calculateDiscount(item.previousPrice, item.price) };\n      }).filter((item) => item.name && item.price !== null && item.url && /^https:\\/\\//i.test(item.url)) };
    } catch (error) {
      logger.warn('Falha ao consultar ofertas da Shopee.', error?.name === 'AbortError' ? 'timeout' : 'network');
      return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  async fetch() {
    if (!this.isConfigured()) return { ok: false, offers: [], errors: ['Shopee não configurada.'], reason: 'not-configured' };
    const offers = [];
    const errors = [];
    for (const keyword of this.keywords) {
      const result = await this.queryProducts(keyword);
      if (!result.ok) {
        errors.push({ keyword, reason: result.reason });
        continue;
      }
      offers.push(...result.offers);
    }
    const unique = new Map();
    for (const offer of offers) {
      const key = offer.externalId || offer.url;
      if (key && !unique.has(key)) unique.set(key, offer);
    }
    return { ok: true, offers: [...unique.values()], errors, skipped: 0, reason: null };
  }

  async fetchOffers() {
    const result = await this.fetch();
    return result.offers;
  }
}

export { SEARCH_TERMS as SHOPEE_SEARCH_TERMS };

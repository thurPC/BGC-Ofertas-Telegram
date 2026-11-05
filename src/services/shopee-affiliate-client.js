import { createHash } from 'node:crypto';
import { roundMoney } from './validation-service.js';

export const DEFAULT_SHOPEE_ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';
export const DEFAULT_TIMEOUT_MS = 12000;
export const MAX_BODY_BYTES = 256_000;
export const MAX_LIMIT = 50;

// Códigos de erro da Shopee Affiliate Open API (tabela oficial):
// - 10000: System error (falha interna do serviço Shopee)
// - 10010: Request parsing error (query inválida, sintaxe incorreta)
// - 10020: Identity authentication error (assinatura incorreta/expirou,
//          header de autorização inválido, timestamp inválido, app desativado)
// - 10030: Trigger traffic limiting (rate limit)
// - 11000: Business processing error
export const SHOPEE_ERROR_CODES = Object.freeze({
  SYSTEM_ERROR: 10000,
  REQUEST_PARSING: 10010,
  INVALID_AUTH_HEADER: 10020,
  RATE_LIMIT: 10030,
  BUSINESS_ERROR: 11000
});

const RETRYABLE_REASONS = new Set(['timeout', 'network', 'http-error', 'rate-limited']);
const AUTH_CODES = new Set([
  SHOPEE_ERROR_CODES.INVALID_AUTH_HEADER
]);
const NON_RETRYABLE_CODES = new Set([
  SHOPEE_ERROR_CODES.SYSTEM_ERROR,
  SHOPEE_ERROR_CODES.REQUEST_PARSING,
  SHOPEE_ERROR_CODES.INVALID_AUTH_HEADER
]);

function asText(value) {
  return String(value ?? '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseShopeeMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return roundMoney(numeric);
}

export function parseShopeeRate(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  if (numeric === 0) return 0;
  if (numeric <= 1) return roundMoney(numeric * 100);
  if (numeric < 100) return roundMoney(numeric);
  return null;
}

export function derivePreviousPrice(price, discountRate) {
  const rate = parseShopeeRate(discountRate);
  if (price == null || rate == null || rate <= 0 || rate >= 100) return null;
  return roundMoney(price / (1 - rate / 100));
}

export function firstHttpUrl(value) {
  if (Array.isArray(value)) {
    return value.map((item) => asText(item)).find((item) => /^https?:\/\//i.test(item)) || null;
  }
  const text = asText(value);
  return /^https?:\/\//i.test(text) ? text : null;
}

export function isShopeeProductUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return (
      host === 'shopee.com.br' ||
      host.endsWith('.shopee.com.br') ||
      host === 'shopee.com' ||
      host.endsWith('.shopee.com') ||
      host === 'shope.ee' ||
      host.endsWith('.shope.ee') ||
      host === 's.shopee.com.br' ||
      host === 'shp.ee'
    );
  } catch {
    return false;
  }
}

export function isShopeeAffiliateUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 's.shopee.com.br' || host === 'shope.ee' || host === 'shp.ee') return true;
    if (host.endsWith('.shopee.com.br') || host === 'shopee.com.br') {
      return /(?:[?&](?:uls_trackid|smtt|utm_source|affiliate)|\/an_)/i.test(`${parsed.pathname}${parsed.search}`);
    }
    return false;
  } catch {
    return false;
  }
}

export function extractShopeeIds(url) {
  const match = String(url ?? '').match(/(?:-i\.|\/i\.|\/product\/)(\d+)[./](\d+)/i);
  if (!match) return null;
  return { shopId: match[1], itemId: match[2] };
}

// Assinatura da Shopee Affiliate Open API (conferida com a documentação oficial):
// signature = sha256hex(AppId + Timestamp + Body + Secret)
// e o header usa  SHA256 Credential=<AppId>, Timestamp=<unix>, Signature=<hex>.
// "Body" é exatamente o corpo JSON enviado (a mesma string assinada e transmitida).
export function signShopeeRequest(appId, secret, body, timestamp) {
  return createHash('sha256')
    .update(String(appId) + String(timestamp) + String(body) + String(secret), 'utf8')
    .digest('hex');
}

export function buildShopeeAuthorization(appId, secret, body, timestamp) {
  const signature = signShopeeRequest(appId, secret, body, timestamp);
  return `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;
}

function gqlValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(String(value));
}

export function buildProductOfferQuery({
  keyword,
  itemId,
  shopId,
  page = 1,
  limit = 20,
  sortType = 1,
  listType = 0
} = {}) {
  const args = [];
  if (keyword) args.push(`keyword: ${gqlValue(keyword)}`);
  if (itemId != null && itemId !== '') args.push(`itemId: ${gqlValue(Number(itemId) || itemId)}`);
  if (shopId != null && shopId !== '') args.push(`shopId: ${gqlValue(Number(shopId) || shopId)}`);
  args.push(`listType: ${Number.parseInt(listType, 10) || 0}`);
  args.push(`sortType: ${Number.parseInt(sortType, 10) || 1}`);
  args.push(`page: ${Math.max(1, Number.parseInt(page, 10) || 1)}`);
  args.push(`limit: ${Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(limit, 10) || 20))}`);
  return (
    `query { productOfferV2(${args.join(', ')}) { ` +
    'nodes { itemId productName shopId shopName productLink offerLink imageUrl ' +
    'priceMin priceMax priceDiscountRate sales ratingStar commissionRate commission periodEndTime } ' +
    'pageInfo { page limit hasNextPage } } }'
  );
}

export function buildShortLinkMutation(originUrl, subIds = []) {
  const ids = Array.isArray(subIds) ? subIds.map(asText).filter(Boolean).slice(0, 5) : [];
  const extra = ids.length ? `, subIds: [${ids.map((id) => JSON.stringify(id)).join(', ')}]` : '';
  return `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}${extra} }) { shortLink } }`;
}

export function normalizeShopeeProduct(node = {}, { category = null } = {}) {
  const price = parseShopeeMoney(node.priceMin ?? node.price);
  const discountRate = parseShopeeRate(node.priceDiscountRate);
  const previousPrice = derivePreviousPrice(price, discountRate);
  const itemId = asText(node.itemId ?? node.item_id ?? node.productId);
  const shopId = asText(node.shopId ?? node.shop_id);
  const offerLink = firstHttpUrl(node.offerLink ?? node.offer_link);
  const productLink = firstHttpUrl(node.productLink ?? node.product_link);
  const imageUrl = firstHttpUrl(node.imageUrl ?? node.image_url);
  const commissionRate = parseShopeeRate(node.commissionRate);
  const sales = Number.isFinite(Number(node.sales)) ? Number(node.sales) : null;
  const ratingStar = Number.isFinite(Number(node.ratingStar)) ? Number(node.ratingStar) : null;
  const validUntil = node.periodEndTime ? new Date(Number(node.periodEndTime) * 1000) : null;
  const validUntilIso =
    validUntil && !Number.isNaN(validUntil.getTime()) && validUntil.getTime() > Date.now()
      ? validUntil.toISOString()
      : null;

  return {
    name: asText(node.productName || node.product_name) || null,
    price,
    previousPrice,
    imageUrl,
    url: offerLink || null,
    productLink: productLink || null,
    coupon: null,
    store: asText(node.shopName) || 'Shopee',
    externalId: itemId && shopId ? `shopee:${shopId}:${itemId}` : itemId ? `shopee:${itemId}` : null,
    itemId: itemId || null,
    shopId: shopId || null,
    commissionRate,
    commission: parseShopeeMoney(node.commission),
    sales,
    ratingStar,
    priceDiscountRate: discountRate,
    validUntil: validUntilIso,
    category,
    source: 'shopee-open-api'
  };
}

export function graphqlErrorInfo(payload) {
  const first = Array.isArray(payload?.errors) ? payload.errors[0] : null;
  if (!first) return null;
  const code = first?.extensions?.code ?? first?.code ?? null;
  return {
    message: asText(first?.message) || 'Erro GraphQL da Shopee.',
    code: code == null ? null : Number(code) || code
  };
}

export class ShopeeAffiliateClient {
  constructor({
    appId,
    secret,
    endpoint = DEFAULT_SHOPEE_ENDPOINT,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    subIds = [],
    maxRetries = 2,
    retryBaseMs = 250,
    clockSkewSeconds = 0,
    now
  } = {}) {
    this.appId = asText(appId);
    this.secret = asText(secret);
    this.endpoint = asText(endpoint) || DEFAULT_SHOPEE_ENDPOINT;
    this.fetchImpl = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.subIds = Array.isArray(subIds) ? subIds.map(asText).filter(Boolean).slice(0, 5) : [];
    this.maxRetries = Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : 2;
    this.retryBaseMs = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? retryBaseMs : 250;
    this.clockSkewSeconds = Number.isFinite(clockSkewSeconds) ? clockSkewSeconds : 0;
    // Permite injetar um relógio (útil para testes) ou compensar divergência
    // de relógio entre a máquina e o servidor Shopee (código 10020 "Invalid Timestamp").
    this.now =
      now ||
      (() => Math.floor(Date.now() / 1000) + this.clockSkewSeconds);
  }

  isConfigured() {
    return Boolean(this.appId && this.secret);
  }

  authorization(body, timestamp = this.now()) {
    return buildShopeeAuthorization(this.appId, this.secret, body, timestamp);
  }

  async request(query, { retries } = {}) {
    if (!this.isConfigured()) {
      return { ok: false, error: 'Credenciais da Shopee não configuradas.', reason: 'not-configured' };
    }
    if (typeof this.fetchImpl !== 'function') {
      return { ok: false, error: 'Cliente HTTP indisponível.', reason: 'no-fetch' };
    }
    const body = JSON.stringify({ query });
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return { ok: false, error: 'Requisição excede o limite permitido.', reason: 'body-too-large' };
    }

    const attempts = (retries ?? this.maxRetries) + 1;
    let last = { ok: false, error: 'Falha ao consultar a Shopee.', reason: 'network' };

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryBaseMs * 2 ** (attempt - 1));
      }
      last = await this.#send(body);
      if (last.ok) return last;
      if (!RETRYABLE_REASONS.has(last.reason)) return last;
      if (last.code != null && NON_RETRYABLE_CODES.has(Number(last.code))) return last;
    }
    return last;
  }

  async #send(body) {
    const timestamp = this.now();
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
      const raw = await response.text();
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: `Shopee API recusou a autenticação (HTTP ${response.status}).`, reason: 'auth-error', status: response.status };
      }
      if (response.status === 429) {
        return { ok: false, error: 'Shopee API limitou as requisições.', reason: 'rate-limited', status: 429 };
      }
      if (!response.ok) {
        return {
          ok: false,
          error: `Shopee API respondeu HTTP ${response.status}.`,
          reason: 'http-error',
          status: response.status
        };
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return { ok: false, error: 'Resposta inválida da Shopee API.', reason: 'invalid-json', status: response.status };
      }
      const gqlError = graphqlErrorInfo(payload);
      if (gqlError) {
        const code = Number(gqlError.code);
        const rateLimited = code === SHOPEE_ERROR_CODES.RATE_LIMIT;
        const auth = AUTH_CODES.has(code);
        const reason = rateLimited
          ? 'rate-limited'
          : auth
            ? 'auth-error'
            : code === SHOPEE_ERROR_CODES.SYSTEM_ERROR
              ? 'system-error'
              : 'graphql-error';
        return {
          ok: false,
          error: gqlError.message,
          code: gqlError.code,
          reason,
          status: rateLimited && response.status === 200 ? 429 : response.status
        };
      }
      if (!payload || typeof payload !== 'object' || payload.data == null) {
        return { ok: false, error: 'Resposta GraphQL sem data.', reason: 'invalid-graphql', status: response.status };
      }
      return { ok: true, data: payload.data, status: response.status };
    } catch (error) {
      const timeout = error?.name === 'AbortError' || /timeout/i.test(String(error?.message || ''));
      return {
        ok: false,
        error: timeout ? 'Tempo esgotado ao consultar a Shopee.' : 'Falha de rede ao consultar a Shopee.',
        reason: timeout ? 'timeout' : 'network'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async searchProducts(keyword, { page = 1, limit = 20, sortType = 1, listType = 0, category = null } = {}) {
    const query = buildProductOfferQuery({ keyword, page, limit, sortType, listType });
    const result = await this.request(query);
    if (!result.ok) return result;
    const payload = result.data?.productOfferV2;
    const nodes = payload?.nodes;
    if (!Array.isArray(nodes)) {
      return { ok: false, error: 'Resposta GraphQL sem lista de produtos.', reason: 'invalid-graphql' };
    }
    const products = nodes
      .filter((node) => node && typeof node === 'object')
      .map((node) => normalizeShopeeProduct(node, { category }));
    const pageInfo = payload?.pageInfo && typeof payload.pageInfo === 'object'
      ? {
          page: Number(payload.pageInfo.page) || page,
          limit: Number(payload.pageInfo.limit) || limit,
          hasNextPage: Boolean(payload.pageInfo.hasNextPage)
        }
      : { page, limit, hasNextPage: false };
    return { ok: true, products, pageInfo };
  }

  async findProductOffer(url) {
    const ids = extractShopeeIds(url);
    if (!ids) {
      return { ok: false, error: 'O link não contém identificadores públicos do produto.', reason: 'missing-product-id' };
    }
    const query = buildProductOfferQuery({ itemId: ids.itemId, shopId: ids.shopId, page: 1, limit: 1 });
    const result = await this.request(query);
    if (!result.ok) return result;
    const nodes = result.data?.productOfferV2?.nodes;
    const node = Array.isArray(nodes) ? nodes[0] : null;
    if (!node) {
      return { ok: false, error: 'Nenhuma oferta de afiliado encontrada para este produto.', reason: 'not-found' };
    }
    return { ok: true, product: normalizeShopeeProduct(node) };
  }

  async generateShortLink(originUrl, { subIds = this.subIds } = {}) {
    if (!isShopeeProductUrl(originUrl)) {
      return { ok: false, error: 'Informe um link HTTPS válido da Shopee.', reason: 'invalid-url' };
    }
    const query = buildShortLinkMutation(String(originUrl), subIds);
    const result = await this.request(query);
    if (!result.ok) return result;
    const shortLink = asText(result.data?.generateShortLink?.shortLink);
    if (!shortLink) {
      return { ok: false, error: 'A Shopee não retornou o link de afiliado.', reason: 'empty-link' };
    }
    if (!/^https:\/\//i.test(shortLink)) {
      return { ok: false, error: 'Link de afiliado retornado é inválido.', reason: 'invalid-affiliate-link' };
    }
    return { ok: true, shortLink };
  }
}

export function createShopeeAffiliateClient(config = {}, options = {}) {
  return new ShopeeAffiliateClient({
    appId: config.shopeeAppId,
    secret: config.shopeeAppSecret,
    endpoint: config.shopeeApiUrl,
    subIds: config.shopeeSubIds,
    timeoutMs: config.shopeeTimeoutMs,
    clockSkewSeconds: config.shopeeClockSkewSeconds,
    ...options
  });
}

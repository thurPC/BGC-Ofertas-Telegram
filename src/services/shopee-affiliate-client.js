import { createHash } from 'node:crypto';

const DEFAULT_ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_BODY_BYTES = 256_000;

function asText(value) {
  return String(value ?? '').trim();
}

function safeJsonStringify(value) {
  return JSON.stringify(value);
}

function parsePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  // A API pode retornar valores monetários em centavos; não inferimos unidade
  // automaticamente. O schema documentado retorna números em unidade monetária.
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

function normalizeProduct(node = {}) {
  const price = parsePrice(node.price);
  const discountRate = Number(node.priceDiscountRate);
  const originalPrice = price !== null && Number.isFinite(discountRate) && discountRate > 0 && discountRate < 100
    ? Math.round((price / (1 - discountRate / 100) + Number.EPSILON) * 100) / 100
    : null;
  const images = Array.isArray(node.imageUrl) ? node.imageUrl : [];
  return {
    name: asText(node.productName || node.product_name) || null,
    price,
    previousPrice: originalPrice,
    imageUrl: images.find((url) => /^https?:\/\//i.test(String(url))) || null,
    url: asText(node.offerLink || node.offer_link || node.productLink || node.product_link) || null,
    productId: asText(node.itemId || node.item_id || node.productId) || null,
    shopId: asText(node.shopId || node.shop_id) || null,
    store: 'Shopee',
    coupon: null
  };
}

export class ShopeeAffiliateClient {
  constructor({ appId, secret, endpoint = DEFAULT_ENDPOINT, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, subIds = [] } = {}) {
    this.appId = asText(appId);
    this.secret = asText(secret);
    this.endpoint = asText(endpoint) || DEFAULT_ENDPOINT;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.subIds = Array.isArray(subIds) ? subIds.map(asText).filter(Boolean).slice(0, 5) : [];
  }

  isConfigured() {
    return Boolean(this.appId && this.secret);
  }

  authorization(body, timestamp = Math.floor(Date.now() / 1000)) {
    const signature = createHash('sha256')
      .update(this.appId + String(timestamp) + body + this.secret, 'utf8')
      .digest('hex');
    return `SHA256 Credential=${this.appId}, Timestamp=${timestamp}, Signature=${signature}`;
  }

  async request(query, variables = {}) {
    if (!this.isConfigured()) return { ok: false, error: 'Credenciais da Shopee não configuradas.', reason: 'not-configured' };
    if (typeof this.fetchImpl !== 'function') return { ok: false, error: 'Cliente HTTP indisponível.', reason: 'no-fetch' };
    const body = safeJsonStringify({ query, ...(Object.keys(variables).length ? { variables } : {}) });
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return { ok: false, error: 'Requisição excede o limite permitido.', reason: 'body-too-large' };
    }
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
      const raw = await response.text();
      if (!response.ok) return { ok: false, error: `Shopee API respondeu HTTP ${response.status}.`, reason: 'http-error' };
      let payload;
      try { payload = JSON.parse(raw); }
      catch { return { ok: false, error: 'Resposta inválida da Shopee API.', reason: 'invalid-json' }; }
      if (Array.isArray(payload.errors) && payload.errors.length) {
        const code = payload.errors[0]?.extensions?.code ?? null;
        return { ok: false, error: String(payload.errors[0]?.message || 'Erro GraphQL da Shopee.'), code, reason: 'graphql-error' };
      }
      return { ok: true, data: payload.data || {} };
    } catch (error) {
      const timeout = error?.name === 'AbortError';
      return { ok: false, error: timeout ? 'Tempo esgotado ao consultar a Shopee.' : 'Falha de rede ao consultar a Shopee.', reason: timeout ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  async generateShortLink(originUrl, { subIds = this.subIds } = {}) {
    let parsed;
    try { parsed = new URL(String(originUrl)); }
    catch { return { ok: false, error: 'Link de produto inválido.', reason: 'invalid-url' }; }
    if (parsed.protocol !== 'https:' || !/(^|\.)shopee\.(com\.br|com)$|(^|\.)shope\.ee$/i.test(parsed.hostname)) {
      return { ok: false, error: 'Informe um link HTTPS válido da Shopee.', reason: 'invalid-url' };
    }
    const ids = Array.isArray(subIds) ? subIds.map(asText).filter(Boolean).slice(0, 5) : [];
    const subIdsLiteral = ids.length ? `, subIds: [${ids.map((id) => JSON.stringify(id)).join(', ')}]` : '';
    const query = `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(parsed.toString())}${subIdsLiteral} }) { shortLink } }`;
    const result = await this.request(query);
    if (!result.ok) return result;
    const shortLink = asText(result.data?.generateShortLink?.shortLink);
    if (!shortLink) return { ok: false, error: 'A Shopee não retornou o link de afiliado.', reason: 'empty-link' };
    return { ok: true, shortLink };
  }

  async findProductOffer(url) {
    // Extrai apenas identificadores do padrão público /i.<shopId>.<itemId>.
    // O GraphQL schema exato é validado contra a resposta real em teste de integração.
    const match = String(url).match(/(?:-i\.|\/i\.)(\d+)\.(\d+)/i);
    if (!match) return { ok: false, error: 'O link não contém identificadores públicos do produto.', reason: 'missing-product-id' };
    const query = `query { productOfferV2(itemId: ${match[2]}, shopId: ${match[1]}) { nodes { productName itemId shopId offerLink imageUrl price priceDiscountRate } } }`;
    const result = await this.request(query);
    if (!result.ok) return result;
    const nodes = result.data?.productOfferV2?.nodes;
    const node = Array.isArray(nodes) ? nodes[0] : null;
    if (!node) return { ok: false, error: 'Nenhuma oferta de afiliado encontrada para este produto.', reason: 'not-found' };
    return { ok: true, product: normalizeProduct(node) };
  }

  async enrichProductUrl(url) {
    const offer = await this.findProductOffer(url);
    if (!offer.ok) return offer;
    const link = await this.generateShortLink(url);
    return { ok: true, product: { ...offer.product, url: link.ok ? link.shortLink : offer.product.url || url }, affiliateLinkGenerated: link.ok };
  }
}

export function createShopeeAffiliateClient(config = {}, options = {}) {
  return new ShopeeAffiliateClient({
    appId: config.shopeeAppId,
    secret: config.shopeeAppSecret,
    endpoint: config.shopeeApiUrl,
    subIds: config.shopeeSubIds,
    ...options
  });
}

export { DEFAULT_ENDPOINT };

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ShopeeAffiliateClient,
  buildProductOfferQuery,
  buildShopeeAuthorization,
  derivePreviousPrice,
  extractShopeeIds,
  isShopeeAffiliateUrl,
  isShopeeProductUrl,
  normalizeShopeeProduct,
  parseShopeeMoney,
  parseShopeeRate,
  signShopeeRequest
} from '../src/services/shopee-affiliate-client.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof payload === 'string' ? payload : JSON.stringify(payload);
    }
  };
}

test('assina a requisição com SHA-256 no formato Shopee', () => {
  const body = '{"query":"{ shopOfferV2 }"}';
  const timestamp = 1700000000;
  const expected = createHash('sha256')
    .update(`123${timestamp}${body}segredo`, 'utf8')
    .digest('hex');
  assert.equal(signShopeeRequest('123', 'segredo', body, timestamp), expected);
  assert.equal(
    buildShopeeAuthorization('123', 'segredo', body, timestamp),
    `SHA256 Credential=123, Timestamp=1700000000, Signature=${expected}`
  );
  const client = new ShopeeAffiliateClient({ appId: '123', secret: 'segredo' });
  assert.equal(client.authorization(body, timestamp), buildShopeeAuthorization('123', 'segredo', body, timestamp));
});

test('converte preços e taxas sem inventar unidade', () => {
  assert.equal(parseShopeeMoney('99.90'), 99.9);
  assert.equal(parseShopeeMoney(-1), null);
  assert.equal(parseShopeeMoney('abc'), null);
  assert.equal(parseShopeeRate(0.23), 23);
  assert.equal(parseShopeeRate(23), 23);
  assert.equal(parseShopeeRate(150), null);
  assert.equal(derivePreviousPrice(77, 23), 100);
  assert.equal(derivePreviousPrice(100, 0), null);
});

test('identifica links de produto e de afiliado Shopee', () => {
  assert.equal(isShopeeProductUrl('https://shopee.com.br/produto-i.111.222'), true);
  assert.equal(isShopeeProductUrl('https://s.shopee.com.br/abc'), true);
  assert.equal(isShopeeProductUrl('https://example.com/x'), false);
  assert.equal(isShopeeAffiliateUrl('https://s.shopee.com.br/abc'), true);
  assert.equal(isShopeeAffiliateUrl('https://shopee.com.br/produto-i.111.222'), false);
  assert.equal(extractShopeeIds('https://shopee.com.br/produto-i.111.222').itemId, '222');
  assert.equal(extractShopeeIds('https://shopee.com.br/product/111/222').shopId, '111');
});

test('normaliza produto GraphQL sem inventar cupom ou preço', () => {
  const product = normalizeShopeeProduct({
    itemId: 10,
    shopId: 20,
    productName: 'Mouse gamer',
    offerLink: 'https://s.shopee.com.br/abc',
    imageUrl: ['https://cf.shopee.com.br/image.jpg'],
    priceMin: '99.90',
    priceDiscountRate: 23,
    shopName: 'Loja teste',
    commissionRate: 8
  });
  assert.equal(product.name, 'Mouse gamer');
  assert.equal(product.price, 99.9);
  assert.equal(product.previousPrice, 129.74);
  assert.equal(product.url, 'https://s.shopee.com.br/abc');
  assert.equal(product.coupon, null);
  assert.equal(product.externalId, 'shopee:20:10');
  assert.equal(product.commissionRate, 8);
});

test('consulta GraphQL envia assinatura, timeout e variáveis', async () => {
  let request;
  const client = new ShopeeAffiliateClient({
    appId: '123',
    secret: 'segredo',
    maxRetries: 0,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        data: {
          productOfferV2: {
            nodes: [
              {
                itemId: 10,
                shopId: 20,
                productName: 'Headset',
                offerLink: 'https://s.shopee.com.br/xyz',
                priceMin: 50
              }
            ],
            pageInfo: { page: 1, limit: 20, hasNextPage: false }
          }
        }
      });
    }
  });
  const result = await client.searchProducts('games', { category: 'games' });
  assert.equal(result.ok, true);
  assert.equal(result.products[0].name, 'Headset');
  assert.equal(request.url, 'https://open-api.affiliate.shopee.com.br/graphql');
  assert.match(request.options.headers.Authorization, /^SHA256 Credential=123, Timestamp=\d+, Signature=[a-f0-9]{64}$/);
  assert.match(request.options.body, /productOfferV2/);
  assert.match(request.options.body, /games/);
  assert.match(buildProductOfferQuery({ keyword: 'games' }), /keyword: "games"/);
});

test('gera link curto e recusa URL de outro domínio', async () => {
  const client = new ShopeeAffiliateClient({
    appId: '123',
    secret: 'segredo',
    maxRetries: 0,
    fetchImpl: async (_url, options) => {
      assert.match(options.body, /generateShortLink/);
      return jsonResponse({ data: { generateShortLink: { shortLink: 'https://s.shopee.com.br/abc' } } });
    }
  });
  const ok = await client.generateShortLink('https://shopee.com.br/produto-i.111.222');
  assert.deepEqual(ok, { ok: true, shortLink: 'https://s.shopee.com.br/abc' });
  const invalid = await client.generateShortLink('https://example.com/produto');
  assert.equal(invalid.reason, 'invalid-url');
});

test('trata autenticação, HTTP, timeout, JSON inválido e GraphQL', async () => {
  const missing = new ShopeeAffiliateClient();
  assert.equal((await missing.searchProducts('x')).reason, 'not-configured');

  const auth = new ShopeeAffiliateClient({
    appId: '1',
    secret: 'x',
    maxRetries: 0,
    fetchImpl: async () => jsonResponse({ errors: [{ message: 'Invalid credential', extensions: { code: 10020 } }] })
  });
  const authResult = await auth.searchProducts('x');
  assert.equal(authResult.ok, false);
  assert.equal(authResult.reason, 'auth-error');
  assert.equal(authResult.code, 10020);

  const http = new ShopeeAffiliateClient({
    appId: '1',
    secret: 'x',
    maxRetries: 0,
    fetchImpl: async () => jsonResponse('erro', 503)
  });
  assert.equal((await http.searchProducts('x')).reason, 'http-error');

  const invalid = new ShopeeAffiliateClient({
    appId: '1',
    secret: 'x',
    maxRetries: 0,
    fetchImpl: async () => jsonResponse('{quebrado')
  });
  assert.equal((await invalid.searchProducts('x')).reason, 'invalid-json');

  const empty = new ShopeeAffiliateClient({
    appId: '1',
    secret: 'x',
    maxRetries: 0,
    fetchImpl: async () => jsonResponse({ data: { productOfferV2: { nodes: null } } })
  });
  assert.equal((await empty.searchProducts('x')).reason, 'invalid-graphql');

  const timeout = new ShopeeAffiliateClient({
    appId: '1',
    secret: 'x',
    timeoutMs: 5,
    maxRetries: 0,
    fetchImpl: async (_url, options) =>
      new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
  });
  assert.equal((await timeout.searchProducts('x')).reason, 'timeout');
});

test('retry com backoff em falha transitória e desiste em erro de autenticação', async () => {
  let calls = 0;
  const retry = new ShopeeAffiliateClient({
    appId: '1',
    secret: 'x',
    maxRetries: 2,
    retryBaseMs: 1,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return jsonResponse('fail', 503);
      return jsonResponse({ data: { productOfferV2: { nodes: [], pageInfo: { hasNextPage: false } } } });
    }
  });
  const recovered = await retry.searchProducts('x');
  assert.equal(recovered.ok, true);
  assert.equal(calls, 3);

  let authCalls = 0;
  const auth = new ShopeeAffiliateClient({
    appId: '1',
    secret: 'x',
    maxRetries: 3,
    retryBaseMs: 1,
    fetchImpl: async () => {
      authCalls += 1;
      return jsonResponse({ errors: [{ message: 'Invalid', extensions: { code: 10020 } }] });
    }
  });
  assert.equal((await auth.searchProducts('x')).reason, 'auth-error');
  assert.equal(authCalls, 1);
});

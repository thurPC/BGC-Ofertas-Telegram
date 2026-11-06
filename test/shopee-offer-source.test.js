import assert from 'node:assert/strict';
import test from 'node:test';
import { ShopeeOfferSource } from '../src/sources/shopee-offer-source.js';
import { createConfiguredSources } from '../src/sources/json-feed-source.js';
import { ShopeeAffiliateClient } from '../src/services/shopee-affiliate-client.js';

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

test('consulta ofertas por palavra-chave com autenticação SHA256', async () => {
  let call;
  const source = new ShopeeOfferSource({
    appId: '12345',
    secret: 'test-secret',
    keywords: ['periféricos'],
    pageDelayMs: 0,
    keywordDelayMs: 0,
    fetchImpl: async (url, options) => {
      call = { url, options };
      return response({
        data: {
          productOfferV2: {
            nodes: [
              {
                itemId: 10,
                shopId: 20,
                productName: 'Mouse gamer',
                offerLink: 'https://s.shopee.com.br/abc',
                imageUrl: 'https://cf.shopee.com.br/image.jpg',
                priceMin: '99.90',
                priceMax: '129.90',
                priceDiscountRate: 23,
                shopName: 'Loja teste'
              }
            ],
            pageInfo: { page: 1, limit: 20, hasNextPage: false }
          }
        }
      });
    }
  });
  const result = await source.fetch();
  assert.equal(call.url, 'https://open-api.affiliate.shopee.com.br/graphql');
  assert.match(call.options.headers.Authorization, /^SHA256 Credential=12345, Timestamp=\d+, Signature=[a-f0-9]{64}$/);
  assert.match(call.options.body, /periféricos/);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].name, 'Mouse gamer');
  assert.equal(result.offers[0].price, 99.9);
  assert.equal(result.offers[0].url, 'https://s.shopee.com.br/abc');
  assert.equal(result.offers[0].discountPercent, 23);
});

test('descarta itens sem offerLink de afiliado, preço ou nome', async () => {
  const source = new ShopeeOfferSource({
    appId: '1',
    secret: 'x',
    keywords: ['games'],
    pageDelayMs: 0,
    keywordDelayMs: 0,
    fetchImpl: async () =>
      response({
        data: {
          productOfferV2: {
            nodes: [
              { itemId: 1, shopId: 2, productName: 'Sem link', priceMin: 10, productLink: 'https://shopee.com.br/item' },
              { itemId: 3, shopId: 4, productName: 'Sem preço', offerLink: 'https://s.shopee.com.br/a' },
              { itemId: 5, shopId: 6, priceMin: 5, offerLink: 'https://s.shopee.com.br/b' }
            ],
            pageInfo: { hasNextPage: false }
          }
        }
      })
  });
  const result = await source.fetch();
  assert.equal(result.ok, true, 'a consulta funcionou, embora nenhum produto seja elegível');
  assert.equal(result.offers.length, 0, 'todos os três produtos devem ser descartados');
});

test('propaga mensagem GraphQL e interrompe após erro de autenticação', async () => {
  let calls = 0;
  const source = new ShopeeOfferSource({
    appId: '1',
    secret: 'x',
    keywords: ['games', 'tecnologia'],
    pageDelayMs: 0,
    keywordDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return response({
        errors: [{ message: 'error [10020]: Invalid Authorization Header', extensions: { code: 10020 } }]
      });
    }
  });
  const result = await source.fetch();
  assert.equal(result.ok, false);
  assert.equal(result.offers.length, 0);
  assert.equal(result.errors[0].reason, 'auth-error');
  assert.match(result.errors[0].error, /Invalid Authorization Header/);
  assert.equal(calls, 1);
});

test('interrompe a busca após erro de sistema (10000)', async () => {
  let calls = 0;
  const source = new ShopeeOfferSource({
    appId: '1',
    secret: 'x',
    keywords: ['games', 'tecnologia'],
    pageDelayMs: 0,
    keywordDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return response({
        errors: [{ message: 'System error', extensions: { code: 10000 } }]
      });
    }
  });
  const result = await source.fetch();
  assert.equal(result.ok, false);
  assert.equal(result.offers.length, 0);
  assert.equal(result.errors[0].reason, 'system-error');
  assert.equal(result.errors[0].code, 10000);
  assert.equal(calls, 1, 'deve interromper a busca após erro de sistema');
});

test('não faz chamada se as credenciais não existem', async () => {
  const source = new ShopeeOfferSource({
    keywords: ['casa'],
    fetchImpl: async () => {
      throw new Error('não deveria chamar');
    }
  });
  const result = await source.fetch();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-configured');
});

test('pagina enquanto hasNextPage for verdadeiro até o limite', async () => {
  const pages = [];
  const source = new ShopeeOfferSource({
    client: new ShopeeAffiliateClient({
      appId: '1',
      secret: 'x',
      maxRetries: 0,
      fetchImpl: async (_url, options) => {
        const page = /page: (\d+)/.exec(options.body)?.[1];
        pages.push(page);
        return response({
          data: {
            productOfferV2: {
              nodes: [
                {
                  itemId: page,
                  shopId: 1,
                  productName: `Item ${page}`,
                  offerLink: `https://s.shopee.com.br/${page}`,
                  priceMin: 10
                }
              ],
              pageInfo: { page: Number(page), hasNextPage: page === '1' }
            }
          }
        });
      }
    }),
    keywords: ['tecnologia'],
    maxPages: 2,
    pageDelayMs: 0,
    keywordDelayMs: 0
  });
  const result = await source.fetch();
  assert.deepEqual(pages, ['1', '2']);
  assert.equal(result.offers.length, 2);
});

test('deduplica o mesmo item Shopee com links curtos diferentes', async () => {
  let calls = 0;
  const source = new ShopeeOfferSource({
    appId: '1',
    secret: 'x',
    keywords: ['games', 'tecnologia'],
    pageDelayMs: 0,
    keywordDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return response({
        data: {
          productOfferV2: {
            nodes: [
              {
                itemId: 10,
                shopId: 20,
                productName: calls === 1 ? 'Mouse gamer' : 'Mouse Gamer RGB',
                offerLink: `https://s.shopee.com.br/${calls}`,
                productLink: 'https://shopee.com.br/item-i.20.10',
                priceMin: calls === 1 ? '99.90' : '89.90',
                shopName: 'Loja teste'
              }
            ],
            pageInfo: { hasNextPage: false }
          }
        }
      });
    }
  });
  const result = await source.fetch();
  assert.equal(calls, 2);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].externalId, 'shopee:20:10');
  assert.equal(result.offers[0].url, 'https://s.shopee.com.br/1');
  assert.equal(result.offers[0].productLink, 'https://shopee.com.br/item-i.20.10');
});

test('createConfiguredSources inclui Shopee somente com credenciais', () => {
  assert.equal(createConfiguredSources({ feedUrl: '', shopeeAppId: '', shopeeAppSecret: '' }).length, 0);
  const sources = createConfiguredSources({
    feedUrl: '',
    shopeeAppId: '1',
    shopeeAppSecret: 'x',
    shopeeKeywords: ['games']
  });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].name, 'shopee-open-api');
  assert.equal(sources[0].isConfigured(), true);
});


test('retorna falha quando todas as palavras-chave falham, mesmo sem erro crítico', async () => {
  const source = new ShopeeOfferSource({
    client: {
      isConfigured: () => true,
      async searchProducts() {
        return { ok: false, reason: 'graphql-error', error: 'Business error', code: 11000 };
      }
    },
    keywords: ['games', 'tecnologia'],
    keywordDelayMs: 0
  });
  const result = await source.fetch();
  assert.equal(result.ok, false);
  assert.equal(result.offers.length, 0);
  assert.equal(result.errors.length, 2);
  assert.equal(result.reason, 'graphql-error');
});

test('mantém sucesso parcial quando uma palavra-chave funciona e outra falha sem erro crítico', async () => {
  let calls = 0;
  const source = new ShopeeOfferSource({
    client: {
      isConfigured: () => true,
      async searchProducts() {
        calls += 1;
        if (calls === 1) return {
          ok: true,
          products: [{
            name: 'Mouse gamer',
            price: 10,
            previousPrice: 20,
            url: 'https://s.shopee.com.br/mouse',
            store: 'Shopee'
          }],
          pageInfo: { hasNextPage: false }
        };
        return { ok: false, reason: 'graphql-error', error: 'Business error', code: 11000 };
      }
    },
    keywords: ['games', 'tecnologia'],
    keywordDelayMs: 0
  });
  const result = await source.fetch();
  assert.equal(result.ok, true);
  assert.equal(result.partial, true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].name, 'Mouse gamer');
});

test('propaga metadados de diagnóstico para os logs e resultado da fonte', async () => {
  const source = new ShopeeOfferSource({
    client: {
      isConfigured: () => true,
      async searchProducts() {
        return {
          ok: false,
          reason: 'system-error',
          error: 'System error',
          code: 10000,
          diagnostics: {
            httpStatus: 200,
            contentType: 'application/json',
            requestId: 'req-safe-1',
            graphqlPath: ['productOfferV2']
          }
        };
      }
    },
    keywords: ['games'],
    keywordDelayMs: 0
  });
  const result = await source.fetch();
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].diagnostics.httpStatus, 200);
  assert.equal(result.errors[0].diagnostics.requestId, 'req-safe-1');
  assert.deepEqual(result.errors[0].diagnostics.graphqlPath, ['productOfferV2']);
});

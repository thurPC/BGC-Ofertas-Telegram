import assert from 'node:assert/strict';
import test from 'node:test';
import { ShopeeOfferSource } from '../src/sources/shopee-offer-source.js';

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

test('consulta ofertas por palavra-chave com autenticação SHA256', async () => {
  let call;
  const source = new ShopeeOfferSource({
    appId: '12345',
    secret: 'test-secret',
    keywords: ['periféricos'],
    fetchImpl: async (url, options) => {
      call = { url, options };
      return response({ data: { productOfferV2: { nodes: [{
        itemId: 10,
        shopId: 20,
        productName: 'Mouse gamer',
        offerLink: 'https://s.shopee.com.br/abc',
        imageUrl: 'https://cf.shopee.com.br/image.jpg',
        priceMin: '99.90',
        priceMax: '129.90',
        priceDiscountRate: 23,
        shopName: 'Loja teste'
      }] } } });
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
    fetchImpl: async () => response({ data: { productOfferV2: { nodes: [
      { itemId: 1, shopId: 2, productName: 'Sem link', priceMin: 10, productLink: 'https://shopee.com.br/item' },
      { itemId: 3, shopId: 4, productName: 'Sem preço', offerLink: 'https://s.shopee.com.br/a' },
      { itemId: 5, shopId: 6, priceMin: 5, offerLink: 'https://s.shopee.com.br/b' }
    ] } } })
  });
  const result = await source.fetch();
  assert.equal(result.offers.length, 0);
});

test('não faz chamada se as credenciais não existem', async () => {
  const source = new ShopeeOfferSource({ keywords: ['casa'], fetchImpl: async () => { throw new Error('não deveria chamar'); } });
  const result = await source.fetch();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-configured');
});

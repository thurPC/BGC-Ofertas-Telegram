import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalShopeeExternalId,
  offerIdentityKeys,
  offersShareIdentity
} from '../src/services/offer-identity.js';

test('identidade Shopee usa shop e item, não o link curto de afiliado', () => {
  const first = {
    name: 'Mouse Gamer',
    store: 'Loja A',
    url: 'https://s.shopee.com.br/abc',
    productLink: 'https://shopee.com.br/mouse-i.20.10',
    externalId: 'shopee:20:10',
    price: 99.9
  };
  const second = {
    name: 'Mouse Gamer RGB 16000DPI',
    store: 'Loja A',
    url: 'https://s.shopee.com.br/xyz',
    itemId: '10',
    shopId: '20',
    price: 89.9
  };
  assert.equal(canonicalShopeeExternalId(first), 'shopee:20:10');
  assert.equal(canonicalShopeeExternalId(second), 'shopee:20:10');
  assert.equal(offersShareIdentity(first, second), true);
  assert.ok(offerIdentityKeys(first).includes('shopee:20:10'));
  assert.equal(offerIdentityKeys(first).includes('https://s.shopee.com.br/abc'), true);
});

test('shopee:itemId avulso casa com shopee:shop:item', () => {
  assert.equal(
    offersShareIdentity({ externalId: 'shopee:10' }, { externalId: 'shopee:20:10' }),
    true
  );
});

test('produtos distintos não compartilham identidade', () => {
  assert.equal(
    offersShareIdentity(
      { name: 'Mouse', store: 'Loja A', url: 'https://s.shopee.com.br/a', externalId: 'shopee:1:1' },
      { name: 'Teclado', store: 'Loja B', url: 'https://s.shopee.com.br/b', externalId: 'shopee:1:2' }
    ),
    false
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectCategory,
  hasEssentialOfferData,
  rankOffers,
  scoreOffer
} from '../src/services/offer-scorer.js';
import { evaluateReadiness } from '../src/services/readiness-service.js';
import { loadConfig } from '../src/config.js';

function offer(extra = {}) {
  return {
    name: 'Mouse Gamer RGB',
    price: 89.9,
    previousPrice: 159.9,
    url: 'https://s.shopee.com.br/abc',
    imageUrl: 'https://cf.shopee.com.br/mouse.jpg',
    store: 'Shopee',
    source: 'shopee-open-api',
    commissionRate: 8,
    ...extra
  };
}

test('detecta as cinco categorias obrigatórias', () => {
  assert.equal(detectCategory({ name: 'Notebook Gamer 15' }), 'tecnologia');
  assert.equal(detectCategory({ name: 'Teclado mecânico periféricos' }), 'informatica');
  assert.equal(detectCategory({ name: 'Controle Xbox Series' }), 'games');
  assert.equal(detectCategory({ name: 'Smart TV 50 polegadas' }), 'eletronicos');
  assert.equal(detectCategory({ name: 'Air Fryer 4L casa' }), 'casa');
});

test('recusa produto incompleto, sem afiliado Shopee ou duplicado', () => {
  assert.equal(hasEssentialOfferData({ name: 'X', price: 10 }), false);
  assert.equal(scoreOffer({ name: 'X', price: 10, url: 'https://s.shopee.com.br/a' }).reject, 'incomplete');
  assert.equal(
    scoreOffer({
      name: 'Mouse Gamer',
      price: 10,
      url: 'https://shopee.com.br/item-sem-rastreio',
      store: 'Shopee',
      source: 'shopee-open-api'
    }).reject,
    'no-affiliate-link'
  );
  assert.equal(
    scoreOffer(offer({ externalId: 'shopee:1:2' }), { publishedKeys: new Set(['shopee:1:2']) }).reject,
    'duplicate'
  );
  assert.equal(
    scoreOffer(
      offer({
        externalId: 'shopee:20:10',
        url: 'https://s.shopee.com.br/novo'
      }),
      { publishedKeys: new Set(['shopee:20:10', 'shopee:10']) }
    ).reject,
    'duplicate'
  );
});

test('prioriza desconto comprovado, comissão e dados completos', () => {
  const strong = scoreOffer(offer());
  const weak = scoreOffer(
    offer({
      previousPrice: null,
      commissionRate: null,
      imageUrl: null,
      price: 89.9
    })
  );
  assert.equal(strong.reject, null);
  assert.ok(strong.score > weak.score);
  assert.ok(strong.discountPercent > 40);
});

test('não trata desconto anunciado sem preço anterior como promoção forte', () => {
  const scored = scoreOffer(
    offer({
      previousPrice: null,
      priceDiscountRate: 50,
      commissionRate: null
    })
  );
  assert.ok(!scored.reasons.includes('desconto-comprovado'));
});

test('rankOffers limita e ordena pelas melhores pontuações', () => {
  const { selected, rejected } = rankOffers(
    [
      offer({ name: 'Mouse Gamer barato', price: 49.9, previousPrice: 120, commissionRate: 12 }),
      offer({ name: 'Cabo USB genérico', price: 9.9, previousPrice: 10, commissionRate: 0, imageUrl: null }),
      { name: 'Incompleto', price: null, url: 'https://s.shopee.com.br/x' }
    ],
    { limit: 1 }
  );
  assert.equal(selected.length, 1);
  assert.match(selected[0].name, /Mouse Gamer/);
  assert.ok(rejected.length >= 1);
});

test('readiness impede auto publish sem canal, duplicidade ou testes falhos', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100',
    ADMIN_IDS: '1',
    OFFER_AUTO_PUBLISH: 'true',
    SHOPEE_APP_ID: '1',
    SHOPEE_APP_SECRET: 'secret'
  });
  assert.equal(evaluateReadiness(config).ok, true);
  assert.equal(evaluateReadiness({ ...config, channelId: '' }).ok, false);
  assert.equal(evaluateReadiness(config, { testsFailed: true }).ok, false);
  assert.equal(
    evaluateReadiness(config, {
      findDuplicates: () => []
    }).ok,
    false
  );
});

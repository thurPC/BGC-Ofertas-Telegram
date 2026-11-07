import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStorage } from '../src/storage/json-storage.js';
import { OfferService } from '../src/services/offer-service.js';
import { SchedulerService } from '../src/services/scheduler-service.js';
import { parseFeedPayload } from '../src/sources/json-feed-source.js';
import { defaultTemplate, renderOfferMessage } from '../src/services/template-service.js';
import {
  CouponService,
  applyCouponToOffer,
  calculateCouponDiscount,
  couponFromOfferFields,
  evaluateCouponEligibility,
  normalizeCoupon,
  selectBestCoupon
} from '../src/services/coupon-service.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');

function coupon(extra = {}) {
  return normalizeCoupon({
    code: 'ELETRO10',
    type: 'percent',
    value: 10,
    marketplace: 'shopee',
    categories: ['Eletronicos'],
    startsAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-12-31T23:59:59.000Z',
    ...extra
  });
}

function product(extra = {}) {
  return {
    name: 'Fone Bluetooth',
    price: 200,
    category: 'Eletronicos',
    store: 'Shopee',
    marketplace: 'shopee',
    url: 'https://shopee.com.br/produto?afiliado=bgc',
    ...extra
  };
}

async function tempCouponService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-coupons-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  return { service: new CouponService(storage), storage, dir };
}

test('cupom ativo e produto elegivel', () => {
  const result = evaluateCouponEligibility(coupon(), product(), NOW);
  assert.equal(result.eligible, true);
  assert.equal(result.guaranteed, true);
  assert.equal(result.discount.finalPrice, 180);
});

test('cupom expirado', () => {
  const result = evaluateCouponEligibility(
    coupon({ expiresAt: '2026-01-01T00:00:00.000Z' }),
    product(),
    NOW
  );
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('expirado'));
});

test('cupom com inicio futuro', () => {
  const result = evaluateCouponEligibility(
    coupon({ startsAt: '2026-12-01T00:00:00.000Z' }),
    product(),
    NOW
  );
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('inicio-futuro'));
});

test('produto abaixo do valor minimo', () => {
  const result = evaluateCouponEligibility(coupon({ minPurchase: 300 }), product({ price: 200 }), NOW);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('abaixo-do-minimo'));
});

test('cupom percentual', () => {
  const discount = calculateCouponDiscount(coupon({ type: 'percent', value: 15 }), 200);
  assert.equal(discount.ok, true);
  assert.equal(discount.amount, 30);
  assert.equal(discount.finalPrice, 170);
});

test('cupom de valor fixo', () => {
  const discount = calculateCouponDiscount(coupon({ type: 'fixed', value: 25 }), 200);
  assert.equal(discount.ok, true);
  assert.equal(discount.amount, 25);
  assert.equal(discount.finalPrice, 175);
});

test('desconto com limite maximo', () => {
  const discount = calculateCouponDiscount(coupon({ type: 'percent', value: 50, maxDiscount: 20 }), 200);
  assert.equal(discount.amount, 20);
  assert.equal(discount.finalPrice, 180);
});

test('categoria compativel', () => {
  const result = evaluateCouponEligibility(coupon({ categories: ['Eletronicos'] }), product(), NOW);
  assert.equal(result.eligible, true);
});

test('categoria incompativel', () => {
  const result = evaluateCouponEligibility(
    coupon({ categories: ['Moda'] }),
    product({ category: 'Eletronicos' }),
    NOW
  );
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('categoria-incompativel'));
});

test('vendedor compativel', () => {
  const result = evaluateCouponEligibility(coupon({ store: 'Loja Oficial' }), product({ store: 'Loja Oficial' }), NOW);
  assert.equal(result.eligible, true);
});

test('vendedor incompativel', () => {
  const result = evaluateCouponEligibility(coupon({ store: 'Loja Oficial' }), product({ store: 'Outra Loja' }), NOW);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('vendedor-incompativel'));
});

test('restricao de primeira compra nao e apresentada como garantida', () => {
  const result = evaluateCouponEligibility(coupon({ firstPurchaseOnly: true }), product(), NOW);
  assert.equal(result.eligible, true);
  assert.equal(result.guaranteed, false);
  assert.ok(result.reasons.includes('primeira-compra'));
  const offer = applyCouponToOffer(product(), { coupon: coupon({ firstPurchaseOnly: true }), evaluation: result });
  assert.match(offer.couponConditions, /primeira compra/i);
  assert.equal(offer.couponGuaranteed, false);
});

test('produto sem cupom', () => {
  const selection = selectBestCoupon([], product(), NOW);
  assert.equal(selection.coupon, null);
  const offer = applyCouponToOffer(product({ coupon: null }), selection);
  assert.equal(offer.couponMatch, null);
});

test('dois ou mais cupons disponiveis escolhe o maior desconto', () => {
  const selection = selectBestCoupon(
    [coupon({ code: 'A5', value: 5 }), coupon({ code: 'B20', value: 20 }), coupon({ code: 'C10', value: 10 })],
    product(),
    NOW
  );
  assert.equal(selection.coupon.code, 'B20');
  assert.equal(selection.evaluation.discount.finalPrice, 160);
});

test('cupons incompativeis entre si nao sao somados', () => {
  const selection = selectBestCoupon(
    [coupon({ code: 'A10', value: 10, stackable: false }), coupon({ code: 'B15', value: 15, stackable: false })],
    product(),
    NOW
  );
  assert.equal(selection.coupon.code, 'B15');
  assert.equal(selection.evaluation.discount.amount, 30);
});

test('dados incompletos nao associam cupom', () => {
  assert.equal(normalizeCoupon({ type: 'percent', value: 10 }), null);
  const discount = calculateCouponDiscount(coupon({ value: null }), 100);
  assert.equal(discount.ok, false);
});

test('falha na fonte de cupons nao interrompe ofertas', async () => {
  const { service, storage } = await tempCouponService();
  service.sources = [
    {
      name: 'quebrada',
      async fetchCoupons() {
        throw new Error('fonte indisponivel');
      }
    }
  ];
  const refresh = await service.refreshFromSources();
  assert.equal(refresh.ok, true);
  assert.equal(refresh.errors.length, 1);
  const offerService = new OfferService(storage, { couponService: service });
  const created = await offerService.create({
    name: 'Mouse Gamer',
    price: 99.9,
    url: 'https://shopee.com.br/mouse?afiliado=bgc',
    store: 'Shopee'
  });
  assert.equal(created.ok, true);
  assert.equal(created.offer.name, 'Mouse Gamer');
});

test('atualizacao de cupom preserva id e atualiza valor', async () => {
  const { service } = await tempCouponService();
  const first = await service.upsertMany([coupon({ code: 'UP10', value: 10 })]);
  const originalId = first.coupons[0].id;
  const second = await service.upsertMany([coupon({ code: 'UP10', value: 20 })]);
  const updated = second.coupons.find((item) => item.code === 'UP10');
  assert.equal(updated.id, originalId);
  assert.equal(updated.value, 20);
});

test('expiracao de cupom desativa logicamente', async () => {
  const { service } = await tempCouponService();
  await service.upsertMany([coupon({ code: 'OLD', expiresAt: '2020-01-01T00:00:00.000Z' })]);
  const result = await service.expireStale({ at: NOW });
  assert.equal(result.expired, 1);
  const listed = await service.list();
  assert.equal(listed[0].enabled, false);
});

test('persistencia apos reinicializacao', async () => {
  const { storage, dir } = await tempCouponService();
  const first = new CouponService(storage);
  await first.upsertMany([coupon({ code: 'KEEP' })]);
  const second = new CouponService(new JsonStorage(path.join(dir, 'offers.json')));
  const listed = await second.list();
  assert.equal(listed.some((item) => item.code === 'KEEP'), true);
});

test('formatacao correta da publicacao BGC PROMOS com cupom', () => {
  const offer = applyCouponToOffer(product({ coupon: null }), {
    coupon: coupon({ code: 'SHOPEE10', value: 10 }),
    evaluation: evaluateCouponEligibility(coupon({ code: 'SHOPEE10', value: 10 }), product(), NOW)
  });
  const html = renderOfferMessage(offer, { template: defaultTemplate(), channelLink: 'https://t.me/bgcpromos' });
  assert.match(html, /🎟️ Cupom: SHOPEE10/);
  assert.match(html, /com cupom R\$ 180,00/);
  assert.match(html, /https:\/\/shopee\.com\.br\/produto\?afiliado=bgc/);
  assert.doesNotMatch(html, /inline_keyboard/);
});

test('preco final calculado corretamente', () => {
  const percent = calculateCouponDiscount(coupon({ type: 'percent', value: 10, maxDiscount: 15 }), 200);
  assert.equal(percent.finalPrice, 185);
  const fixed = calculateCouponDiscount(coupon({ type: 'fixed', value: 40 }), 200);
  assert.equal(fixed.finalPrice, 160);
});

test('Shopee associa cupom do marketplace correto', () => {
  const shopee = coupon({ code: 'SHOPEE10', marketplace: 'shopee' });
  const meli = coupon({ code: 'MELI10', marketplace: 'mercadolivre' });
  const selection = selectBestCoupon([shopee, meli], product({ url: 'https://shopee.com.br/x', marketplace: 'shopee' }), NOW);
  assert.equal(selection.coupon.code, 'SHOPEE10');
});

test('Mercado Livre associa cupom do marketplace correto', () => {
  const shopee = coupon({ code: 'SHOPEE10', marketplace: 'shopee' });
  const meli = coupon({ code: 'MELI10', marketplace: 'mercadolivre' });
  const selection = selectBestCoupon(
    [shopee, meli],
    product({ store: 'Mercado Livre', marketplace: 'mercadolivre', url: 'https://www.mercadolivre.com.br/x?afiliado=bgc' }),
    NOW
  );
  assert.equal(selection.coupon.code, 'MELI10');
});

test('preservacao dos links de afiliado', () => {
  const url = 'https://shopee.com.br/produto?afiliado=bgc&utm_source=canal';
  const offer = applyCouponToOffer(product({ url }), {
    coupon: coupon(),
    evaluation: evaluateCouponEligibility(coupon(), product({ url }), NOW)
  });
  assert.equal(offer.url, url);
});

test('prevencao de ofertas duplicadas permanece apos associacao', async () => {
  const { service, storage } = await tempCouponService();
  await service.upsertMany([coupon()]);
  const offerService = new OfferService(storage, { couponService: service });
  const sample = {
    name: 'Fone Bluetooth',
    price: 200,
    url: 'https://shopee.com.br/fone?afiliado=bgc',
    store: 'Shopee',
    category: 'Eletronicos'
  };
  const first = await offerService.create(sample);
  const second = await offerService.create(sample);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.duplicate, true);
  const listed = await offerService.list();
  assert.equal(listed.length, 1);
});

test('falha de cupons sem interrupcao das ofertas normais', async () => {
  const broken = {
    async list() {
      throw new Error('storage down');
    },
    async associate() {
      throw new Error('storage down');
    }
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-coupon-fail-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  const offerService = new OfferService(storage, { couponService: broken });
  const created = await offerService.create({
    name: 'Teclado Mecanico',
    price: 350,
    url: 'https://www.mercadolivre.com.br/teclado?afiliado=bgc',
    store: 'Mercado Livre'
  });
  assert.equal(created.ok, true);
});

test('concorrencia e execucao simultanea na gravacao de cupons', async () => {
  const { service } = await tempCouponService();
  await Promise.all([
    service.upsertMany([coupon({ code: 'C1', value: 5 })]),
    service.upsertMany([coupon({ code: 'C2', value: 10 })]),
    service.upsertMany([coupon({ code: 'C3', value: 15 })])
  ]);
  const listed = await service.list();
  assert.equal(listed.length, 3);
});

test('feed JSON extrai cupons do catalogo e do item sem quebrar ofertas', () => {
  const parsed = parseFeedPayload(
    {
      offers: [
        {
          name: 'Produto Shopee',
          price: 99.9,
          url: 'https://shopee.com.br/item?afiliado=bgc',
          store: 'Shopee',
          coupon: 'SHOPEE20'
        }
      ],
      coupons: [
        {
          code: 'MELI15',
          type: 'percent',
          value: 15,
          marketplace: 'mercadolivre'
        }
      ]
    },
    'json-feed'
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.offers.length, 1);
  assert.equal(parsed.offers[0].coupon, 'SHOPEE20');
  assert.equal(parsed.offers[0].url, 'https://shopee.com.br/item?afiliado=bgc');
  assert.ok(parsed.coupons.some((item) => item.code === 'SHOPEE20'));
  assert.ok(parsed.coupons.some((item) => item.code === 'MELI15'));
});

test('agendador importa cupons mesmo com publicacao automatica desativada', async () => {
  const { service } = await tempCouponService();
  const source = {
    name: 'json-feed',
    isConfigured: () => true,
    async fetch() {
      return {
        ok: true,
        offers: [
          {
            name: 'Notebook',
            price: 3000,
            url: 'https://shopee.com.br/note?afiliado=bgc',
            store: 'Shopee',
            coupon: 'NOTE10'
          }
        ],
        coupons: [coupon({ code: 'NOTE10', marketplace: 'shopee' })]
      };
    }
  };
  const scheduler = new SchedulerService({
    config: { autoPublish: false, checkIntervalMinutes: 60, maxOffersPerRun: 5, allowedHours: [] },
    sources: [source],
    offerService: { list: async () => [] },
    publishingService: {},
    couponService: service
  });
  const result = await scheduler.run();
  assert.equal(result.ok, true);
  assert.equal(result.published, 0);
  const listed = await service.list();
  assert.equal(listed.some((item) => item.code === 'NOTE10'), true);
});

test('publicacao automatica persiste cupons do feed e associa na criacao', async () => {
  const { service, storage } = await tempCouponService();
  const offerService = new OfferService(storage, { couponService: service });
  const published = [];
  const source = {
    name: 'json-feed',
    isConfigured: () => true,
    async fetch() {
      return {
        ok: true,
        offers: [
          {
            name: 'Fone Bluetooth',
            price: 200,
            previousPrice: 400,
            imageUrl: 'https://cf.shopee.com.br/fone.jpg',
            url: 'https://shopee.com.br/fone?afiliado=bgc',
            store: 'Shopee',
            category: 'Eletronicos',
            source: 'json-feed'
          }
        ],
        coupons: [coupon({ code: 'ELETRO10', marketplace: 'shopee', categories: ['Eletronicos'] })]
      };
    }
  };
  const scheduler = new SchedulerService({
    config: {
      autoPublish: true,
      checkIntervalMinutes: 60,
      maxOffersPerRun: 5,
      publishGapSeconds: 0,
      minOfferScore: 20,
      requireAffiliateLink: false,
      allowedHours: [],
      maxPrice: null,
      minDiscountPercent: null,
      allowedStores: [],
      channelId: '-100123',
      token: 'x',
      adminIds: [1n],
      feedUrl: 'https://example.com/feed.json'
    },
    sources: [source],
    offerService,
    publishingService: {
      async publish(offer) {
        published.push(offer);
        return { ok: true };
      }
    },
    couponService: service
  });
  const result = await scheduler.run();
  assert.equal(result.ok, true);
  assert.equal(result.imported, 1);
  assert.equal(result.published, 1);
  const listed = await service.list();
  assert.equal(listed.some((item) => item.code === 'ELETRO10'), true);
  assert.equal(published[0].coupon, 'ELETRO10');
  const stored = await offerService.list();
  assert.equal(stored[0].coupon, 'ELETRO10');
});

test('couponFromOfferFields nao inventa desconto', () => {
  const extracted = couponFromOfferFields({ coupon: 'PAGINA10', couponConditions: 'Valido na pagina', store: 'Shopee' });
  assert.equal(extracted.code, 'PAGINA10');
  assert.equal(extracted.value, null);
});

test('nome de marketplace nao e tratado como restricao de vendedor', () => {
  const fromFeed = couponFromOfferFields({
    coupon: 'SHOPEE10',
    store: 'Shopee',
    url: 'https://shopee.com.br/item'
  });
  assert.equal(fromFeed.marketplace, 'shopee');
  assert.equal(fromFeed.store, null);
  const result = evaluateCouponEligibility(fromFeed, product({ store: 'Shopee', category: null }), NOW);
  assert.equal(result.eligible, true);
});

test('produto sem categoria ainda recebe cupom do marketplace, sem garantia', async () => {
  const { service } = await tempCouponService();
  await service.upsertMany([coupon({ categories: ['Eletronicos'] })]);
  const associated = await service.associate(product({ category: null }), { persist: false, at: NOW });
  assert.equal(associated.offer.coupon, 'ELETRO10');
  assert.equal(associated.offer.couponGuaranteed, false);
  assert.equal(associated.offer.couponEstimatedPrice, 180);
  assert.match(associated.offer.couponConditions, /categoria/i);
});

test('cupom da pagina inelegivel cede ao melhor cupom do catalogo', async () => {
  const { service } = await tempCouponService();
  await service.upsertMany([coupon({ code: 'CATALOGO20', value: 20 })]);
  const associated = await service.associate(
    product({ coupon: 'PAGINA10' }),
    { persist: false, at: NOW }
  );
  assert.equal(associated.offer.coupon, 'CATALOGO20');
  assert.equal(associated.offer.couponEstimatedPrice, 160);
});

test('create associa cupom automaticamente sem categoria no cadastro', async () => {
  const { service, storage } = await tempCouponService();
  await service.upsertMany([coupon()]);
  const offerService = new OfferService(storage, { couponService: service });
  const created = await offerService.create({
    name: 'Fone Bluetooth',
    price: 200,
    url: 'https://shopee.com.br/fone?afiliado=bgc',
    store: 'Shopee'
  });
  assert.equal(created.ok, true);
  assert.equal(created.offer.coupon, 'ELETRO10');
  assert.equal(created.offer.couponEstimatedPrice, 180);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JsonFeedSource,
  createConfiguredSources,
  parseFeedPayload
} from '../src/sources/json-feed-source.js';
import { findDuplicates } from '../src/services/offer-service.js';
import { SchedulerService } from '../src/services/scheduler-service.js';

const REAL_FEED_URL = 'https://raw.githubusercontent.com/thurPC/BGC-Ofertas-Telegram/main/feed.json';

const SAMPLE_FEED = {
  offers: [
    {
      name: 'Produto de teste BGC Ofertas',
      price: 99.9,
      previousPrice: 149.9,
      pixPrice: 94.9,
      coupon: 'TESTE10',
      couponConditions: 'Cupom fictício para teste',
      imageUrl: 'https://placehold.co/600x600.png',
      url: 'https://www.mercadolivre.com.br/',
      store: 'Mercado Livre'
    }
  ]
};

function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    }
  };
}

test('interpreta o formato real do feed.json com offers', () => {
  const parsed = parseFeedPayload(SAMPLE_FEED, 'json-feed');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.offers.length, 1);
  const offer = parsed.offers[0];
  assert.equal(offer.name, 'Produto de teste BGC Ofertas');
  assert.equal(offer.price, 99.9);
  assert.equal(offer.previousPrice, 149.9);
  assert.equal(offer.pixPrice, 94.9);
  assert.equal(offer.coupon, 'TESTE10');
  assert.equal(offer.url, 'https://www.mercadolivre.com.br/');
  assert.equal(offer.imageUrl, 'https://placehold.co/600x600.png');
  assert.equal(offer.store, 'Mercado Livre');
});

test('preserva a URL de afiliado exatamente como veio no feed', () => {
  const affiliate = 'https://www.mercadolivre.com.br/sec/abc?matt_word=teste&matt_tool=123';
  const parsed = parseFeedPayload({
    offers: [
      {
        name: 'Headset',
        price: 10,
        url: affiliate,
        store: 'Loja'
      }
    ]
  });
  assert.equal(parsed.offers[0].url, affiliate);
});

test('feed vazio retorna lista vazia sem erro de estrutura', () => {
  const parsed = parseFeedPayload({ offers: [] });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.offers.length, 0);
  assert.equal(parsed.skipped, 0);
});

test('descarta itens inválidos e registra os erros', () => {
  const parsed = parseFeedPayload({
    offers: [
      { name: 'Sem link', price: 10, store: 'Loja' },
      { name: 'Preço negativo', price: -5, url: 'https://loja.example/p', store: 'Loja' },
      'texto',
      {
        name: 'Válida',
        price: 20,
        url: 'https://loja.example/ok',
        store: 'Loja'
      }
    ]
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.offers.length, 1);
  assert.equal(parsed.offers[0].name, 'Válida');
  assert.ok(parsed.skipped >= 3);
  assert.ok(parsed.errors.length >= 3);
});

test('JSON com estrutura inválida não vira oferta', () => {
  const parsed = parseFeedPayload({ foo: 1 });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.offers.length, 0);
  assert.equal(parsed.reason, 'invalid-structure');
});

test('falha HTTP não derruba a fonte', async () => {
  const source = new JsonFeedSource('https://example.test/feed.json', {
    fetchImpl: async () => jsonResponse('erro', 503)
  });
  const result = await source.fetch();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'http-error');
  assert.equal(result.status, 503);
  assert.deepEqual(result.offers, []);
});

test('JSON inválido e timeout são tratados', async () => {
  const invalid = new JsonFeedSource('https://example.test/feed.json', {
    fetchImpl: async () => jsonResponse('{quebrado')
  });
  const invalidResult = await invalid.fetch();
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.reason, 'invalid-json');

  const timeout = new JsonFeedSource('https://example.test/feed.json', {
    timeoutMs: 5,
    fetchImpl: async (_url, options) =>
      new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
  });
  const timeoutResult = await timeout.fetch();
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.reason, 'timeout');
  assert.deepEqual(timeoutResult.offers, []);
});

test('createConfiguredSources só cria fonte quando OFFER_FEED_URL existe', () => {
  assert.equal(createConfiguredSources({ feedUrl: '' }).length, 0);
  const sources = createConfiguredSources({ feedUrl: REAL_FEED_URL });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].isConfigured(), true);
});

test('deduplica a mesma oferta em execuções sucessivas sem republicar', async () => {
  const stored = [];
  const published = [];
  const source = new JsonFeedSource('https://example.test/feed.json', {
    fetchImpl: async () => jsonResponse(SAMPLE_FEED)
  });
  const offerService = {
    async list() {
      return stored.slice();
    },
    async create(input) {
      const offer = { id: `id-${stored.length + 1}`, ...input, status: 'pronta' };
      stored.push(offer);
      return { ok: true, offer };
    }
  };
  const publishingService = {
    async publish(offer) {
      published.push(offer);
      return { ok: true };
    }
  };
  const scheduler = new SchedulerService({
    config: {
      autoPublish: false,
      checkIntervalMinutes: 60,
      maxOffersPerRun: 5,
      allowedHours: [],
      maxPrice: null,
      minDiscountPercent: null,
      allowedStores: []
    },
    sources: [source],
    offerService,
    publishingService
  });

  const first = await scheduler.importFromSources({ publish: false });
  assert.equal(first.ok, true);
  assert.equal(first.imported, 1);
  assert.equal(first.published, 0);
  assert.equal(published.length, 0);
  assert.equal(stored[0].url, 'https://www.mercadolivre.com.br/');

  const second = await scheduler.importFromSources({ publish: false });
  assert.equal(second.imported, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(stored.length, 1);
  assert.equal(published.length, 0);
  assert.equal(findDuplicates(stored, stored[0]).length, 1);
});

test('OFFER_AUTO_PUBLISH permanece desativado por padrão e não publica', async () => {
  const source = new JsonFeedSource(REAL_FEED_URL, {
    fetchImpl: async () => jsonResponse(SAMPLE_FEED)
  });
  let publishCalled = false;
  const scheduler = new SchedulerService({
    config: {
      autoPublish: false,
      checkIntervalMinutes: 60,
      maxOffersPerRun: 5,
      allowedHours: [],
      maxPrice: null,
      minDiscountPercent: null,
      allowedStores: []
    },
    sources: [source],
    offerService: {
      async list() {
        return [];
      },
      async create(input) {
        return { ok: true, offer: { id: 'x', ...input, status: 'pronta' } };
      }
    },
    publishingService: {
      async publish() {
        publishCalled = true;
        return { ok: true };
      }
    }
  });
  const result = await scheduler.run();
  assert.equal(result.ok, true);
  assert.equal(result.imported, 0);
  assert.equal(result.published, 0);
  assert.equal(publishCalled, false);
  assert.ok(result.fetched >= 1);
  assert.match(result.note, /desativada/i);
});

test('lê o feed.json real hospedado no GitHub sem publicar', async () => {
  const source = new JsonFeedSource(REAL_FEED_URL);
  const result = await source.fetch();
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.ok(result.offers.length >= 1);
  const offer = result.offers[0];
  assert.equal(offer.name, 'Produto de teste BGC Ofertas');
  assert.equal(typeof offer.price, 'number');
  assert.ok(offer.price > 0);
  assert.match(offer.url, /^https:\/\//);
  assert.equal(offer.url, 'https://www.mercadolivre.com.br/');
  assert.equal(offer.store, 'Mercado Livre');
  assert.equal(offer.coupon, 'TESTE10');
});

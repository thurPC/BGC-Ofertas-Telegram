import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SchedulerService } from '../src/services/scheduler-service.js';
import { OfferService } from '../src/services/offer-service.js';
import { JsonStorage } from '../src/storage/json-storage.js';
import { formatOfferHtml } from '../src/formatters/offer-message.js';
import { defaultTemplate } from '../src/services/template-service.js';

function sampleOffer(extra = {}) {
  return {
    name: 'Headset Gamer 7.1',
    price: 129.9,
    previousPrice: 249.9,
    imageUrl: 'https://cf.shopee.com.br/headset.jpg',
    url: extra.url || 'https://s.shopee.com.br/headset',
    store: 'Shopee',
    source: 'shopee-open-api',
    externalId: extra.externalId || 'shopee:1:99',
    commissionRate: 10,
    category: 'games',
    ...extra
  };
}

function source(offers, name = 'shopee-open-api') {
  let calls = 0;
  return {
    name,
    isConfigured() {
      return true;
    },
    describe() {
      return { name, configured: true };
    },
    async fetch() {
      calls += 1;
      return { ok: true, offers, errors: [] };
    },
    get calls() {
      return calls;
    }
  };
}

async function tempService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-auto-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  return { service: new OfferService(storage), dir, storage };
}

function config(extra = {}) {
  return {
    autoPublish: false,
    checkIntervalMinutes: 30,
    maxOffersPerRun: 2,
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
    shopeeAppId: '1',
    shopeeAppSecret: 'secret',
    ...extra
  };
}

test('modo teste consulta, pontua e não publica', async () => {
  let published = 0;
  const offers = [sampleOffer(), sampleOffer({ name: 'Mouse Gamer', url: 'https://s.shopee.com.br/mouse', externalId: 'shopee:1:2' })];
  const scheduler = new SchedulerService({
    config: config(),
    sources: [source(offers)],
    offerService: {
      async list() {
        return [];
      },
      async create() {
        throw new Error('não deveria importar no modo teste');
      }
    },
    publishingService: {
      async publish() {
        published += 1;
        return { ok: true };
      },
      async resolveTemplate() {
        return defaultTemplate();
      }
    }
  });
  const result = await scheduler.run();
  assert.equal(result.ok, true);
  assert.equal(result.published, 0);
  assert.equal(published, 0);
  assert.ok(result.selected >= 1);
  assert.match(result.note, /desativada/i);
  assert.ok(result.messages[0].includes('Headset Gamer 7.1'));
});

test('produção publica só as melhores e respeita o limite por execução', async () => {
  const { service } = await tempService();
  const published = [];
  const scheduler = new SchedulerService({
    config: config({ autoPublish: true, maxOffersPerRun: 1, publishGapSeconds: 0 }),
    sources: [
      source([
        sampleOffer({ name: 'Oferta fraca', previousPrice: 130, commissionRate: 0, url: 'https://s.shopee.com.br/fraca', externalId: 'a' }),
        sampleOffer({ name: 'Oferta forte Gamer', previousPrice: 400, commissionRate: 15, url: 'https://s.shopee.com.br/forte', externalId: 'b' })
      ])
    ],
    offerService: service,
    publishingService: {
      async publish(offer) {
        published.push(offer.name);
        return { ok: true };
      }
    },
    sleepFn: async () => undefined
  });
  const result = await scheduler.run();
  assert.equal(result.ok, true);
  assert.equal(result.published, 1);
  assert.equal(published.length, 1);
  assert.match(published[0], /Oferta forte/);
});

test('não republica o mesmo produto Shopee com outro link curto, preço ou título', async () => {
  const { service } = await tempService();
  const published = [];
  const offers = [
    sampleOffer(),
    sampleOffer({
      name: 'Headset Gamer 7.1 RGB',
      price: 119.9,
      url: 'https://s.shopee.com.br/headset-novo',
      externalId: 'shopee:1:99'
    })
  ];
  let round = 0;
  const rotating = {
    name: 'shopee-open-api',
    isConfigured() {
      return true;
    },
    async fetch() {
      const offer = offers[Math.min(round, offers.length - 1)];
      round += 1;
      return { ok: true, offers: [offer], errors: [] };
    }
  };
  const scheduler = new SchedulerService({
    config: config({ autoPublish: true, maxOffersPerRun: 5, publishGapSeconds: 0 }),
    sources: [rotating],
    offerService: service,
    publishingService: {
      async publish(offer) {
        published.push(offer.url);
        return { ok: true };
      }
    },
    sleepFn: async () => undefined
  });
  const first = await scheduler.run();
  const second = await scheduler.run();
  assert.equal(first.published, 1);
  assert.equal(second.published, 0);
  assert.equal(second.duplicates, 1);
  assert.deepEqual(published, ['https://s.shopee.com.br/headset']);
});

test('histórico seenOffers impede republicar após remover a oferta', async () => {
  const { service } = await tempService();
  const published = [];
  const scheduler = new SchedulerService({
    config: config({ autoPublish: true, maxOffersPerRun: 5, publishGapSeconds: 0 }),
    sources: [
      source([
        sampleOffer({
          url: 'https://s.shopee.com.br/um',
          externalId: 'shopee:8:88'
        })
      ])
    ],
    offerService: service,
    publishingService: {
      async publish() {
        published.push('ok');
        return { ok: true };
      }
    },
    sleepFn: async () => undefined
  });
  const first = await scheduler.run();
  assert.equal(first.published, 1);
  const listed = await service.list();
  await service.remove(listed[0].id);
  const second = await scheduler.run();
  assert.equal(second.published, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(published.length, 1);
});

test('bloqueia duplicatas entre execuções e persiste o histórico', async () => {
  const { service, storage } = await tempService();
  const published = [];
  const scheduler = new SchedulerService({
    config: config({ autoPublish: true, maxOffersPerRun: 5, publishGapSeconds: 0 }),
    sources: [source([sampleOffer()])],
    offerService: service,
    publishingService: {
      async publish(offer) {
        published.push(offer.externalId);
        return { ok: true };
      }
    },
    sleepFn: async () => undefined
  });
  const first = await scheduler.run();
  const second = await scheduler.run();
  assert.equal(first.published, 1);
  assert.equal(second.published, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(published.length, 1);
  const db = await storage.read();
  assert.ok(db.seenOffers.includes('shopee:1:99'));
  assert.equal(db.settings.lastAutomationRun.published, 0);
});

test('não sobrepõe execuções simultâneas', async () => {
  let active = 0;
  let maxActive = 0;
  const slow = {
    name: 'slow',
    isConfigured() {
      return true;
    },
    async fetch() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return { ok: true, offers: [], errors: [] };
    }
  };
  const scheduler = new SchedulerService({
    config: config(),
    sources: [slow],
    offerService: { async list() { return []; } },
    publishingService: {}
  });
  const [a, b] = await Promise.all([scheduler.run(), scheduler.run()]);
  const skipped = [a, b].filter((item) => item.skipped);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'already-running');
  assert.equal(maxActive, 1);
});

test('intervalo mínimo entre publicações é respeitado', async () => {
  const waits = [];
  const { service } = await tempService();
  const scheduler = new SchedulerService({
    config: config({ autoPublish: true, maxOffersPerRun: 2, publishGapSeconds: 2, minOfferScore: 10 }),
    sources: [
      source([
        sampleOffer({ name: 'Um Gamer', url: 'https://s.shopee.com.br/1', externalId: '1' }),
        sampleOffer({ name: 'Dois Gamer', url: 'https://s.shopee.com.br/2', externalId: '2' })
      ])
    ],
    offerService: service,
    publishingService: {
      async publish() {
        return { ok: true };
      }
    },
    sleepFn: async (ms) => {
      waits.push(ms);
    }
  });
  const result = await scheduler.run();
  assert.equal(result.published, 2);
  assert.deepEqual(waits, [2000]);
});

test('falha do Telegram não derruba o ciclo e registra o erro', async () => {
  const { service } = await tempService();
  const scheduler = new SchedulerService({
    config: config({ autoPublish: true, maxOffersPerRun: 2, publishGapSeconds: 0 }),
    sources: [
      source([
        sampleOffer({ name: 'Ok Gamer', url: 'https://s.shopee.com.br/ok', externalId: 'ok' }),
        sampleOffer({ name: 'Falhou Gamer', url: 'https://s.shopee.com.br/fail', externalId: 'fail' })
      ])
    ],
    offerService: service,
    publishingService: {
      async publish(offer) {
        if (offer.externalId === 'fail') return { ok: false, error: 'Falha ao publicar no Telegram.' };
        return { ok: true };
      }
    },
    sleepFn: async () => undefined
  });
  const result = await scheduler.run();
  assert.equal(result.ok, true);
  assert.equal(result.published, 1);
  assert.ok(result.errors.some((item) => /Telegram/.test(String(item.errors || item))));
});

test('lock persistente impede segunda instância e lock antigo é recuperado', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-lockrun-'));
  const lockFile = path.join(dir, 'scheduler.lock');
  await fs.writeFile(lockFile, JSON.stringify({ pid: 1, at: new Date().toISOString() }), 'utf8');
  const scheduler = new SchedulerService({
    config: config(),
    sources: [source([sampleOffer()])],
    offerService: { async list() { return []; } },
    publishingService: {},
    lockFile
  });
  const blocked = await scheduler.run();
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, 'lock-held');

  await fs.writeFile(lockFile, JSON.stringify({ pid: 1, at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }), 'utf8');
  const recovered = await scheduler.run();
  assert.equal(recovered.ok, true);
});

test('mensagem automática segue o modelo BGC PROMOS', () => {
  const html = formatOfferHtml(sampleOffer({ coupon: 'BGC10' }), {
    template: defaultTemplate(),
    channelLink: 'https://t.me/bgcpromos'
  });
  assert.match(html, /🔥 Headset Gamer 7\.1/);
  assert.match(html, /💰 R\$ 129,90/);
  assert.match(html, /🎟️ Cupom: BGC10/);
  assert.match(html, /https:\/\/s\.shopee\.com\.br\/headset/);
  assert.match(html, /Compartilhe com os amigos/);
});

test('falha de autenticação na Shopee bloqueia a execução sem publicar nada', async () => {
  const { service } = await tempService();
  let publishCalls = 0;
  const failingSource = {
    name: 'shopee-open-api',
    isConfigured() {
      return true;
    },
    describe() {
      return { name: 'shopee-open-api', configured: true };
    },
    async fetch() {
      return {
        ok: false,
        offers: [],
        errors: [{ message: 'Invalid Authorization Header', code: 10020 }],
        reason: 'auth-error'
      };
    }
  };
  const scheduler = new SchedulerService({
    config: config({ autoPublish: true, maxOffersPerRun: 5, publishGapSeconds: 0 }),
    sources: [
      failingSource,
      source([sampleOffer({
        name: 'Oferta de feed válida',
        source: 'json-feed',
        externalId: 'feed:valid',
        url: 'https://example.com/oferta'
      })], 'json-feed')
    ],
    offerService: service,
    publishingService: {
      async publish() {
        publishCalls += 1;
        return { ok: true };
      }
    },
    sleepFn: async () => undefined
  });
  const result = await scheduler.run();
  assert.equal(result.ok, false, 'o ciclo deve ser marcado como bloqueado');
  assert.equal(result.fetched, 1, 'a fonte saudável foi consultada, mas seu lote também deve ser retido');
  assert.ok(result.selected >= 1, 'a oferta saudável foi selecionada, mas não pode ser importada');
  assert.equal(publishCalls, 0, 'nada deve ser publicado quando a autenticação de uma fonte falha');
  assert.equal(result.imported, 0);
  assert.ok(result.errors.length >= 1);
  assert.match(result.note, /bloqueada/i);
  const stored = await service.list();
  assert.equal(stored.length, 0, 'nada deve ser importado quando a fonte autenticada falha');
});

test('falha transitória do feed JSON não bloqueia ofertas válidas da Shopee', async () => {
  const { service } = await tempService();
  const published = [];
  const failingFeed = {
    name: 'json-feed',
    isConfigured() {
      return true;
    },
    describe() {
      return { name: 'json-feed', configured: true };
    },
    async fetch() {
      return {
        ok: false,
        offers: [],
        errors: ['Falha de rede ao consultar o feed.'],
        reason: 'network'
      };
    }
  };
  const scheduler = new SchedulerService({
    config: config({ autoPublish: true, maxOffersPerRun: 5, publishGapSeconds: 0 }),
    sources: [
      failingFeed,
      source([sampleOffer({
        name: 'Headset Gamer Shopee',
        source: 'shopee-open-api',
        externalId: 'shopee:9:99',
        url: 'https://s.shopee.com.br/headset-ok'
      })], 'shopee-open-api')
    ],
    offerService: service,
    publishingService: {
      async publish(offer) {
        published.push(offer.name);
        return { ok: true };
      }
    },
    sleepFn: async () => undefined
  });
  const result = await scheduler.run();
  assert.equal(result.ok, true);
  assert.equal(result.published, 1);
  assert.equal(result.imported, 1);
  assert.deepEqual(published, ['Headset Gamer Shopee']);
  assert.ok(result.errors.some((item) => item.source === 'json-feed'));
  const stored = await service.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].source, 'shopee-open-api');
});

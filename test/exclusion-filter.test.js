import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeExclusion,
  createExclusionFilter,
  DEFAULT_EXCLUDED_CATEGORIES,
  DEFAULT_EXCLUDED_KEYWORDS,
  exclusionMessage,
  hasWord,
  isExcludedProduct,
  normalizeText
} from '../src/services/exclusion-filter.js';
import { applyOfferFilters } from '../src/sources/source-interface.js';
import { parseFeedPayload } from '../src/sources/json-feed-source.js';
import { OfferService, OFFER_STATUS } from '../src/services/offer-service.js';
import { PublishingService } from '../src/services/publishing-service.js';
import { SchedulerService } from '../src/services/scheduler-service.js';
import { loadConfig } from '../src/config.js';
import { JsonFeedSource } from '../src/sources/json-feed-source.js';

function config(extra = {}) {
  return {
    maxPrice: null,
    minDiscountPercent: null,
    allowedStores: [],
    excludedCategories: [],
    excludedKeywords: [],
    ...extra
  };
}

const BASE_PRODUCT = {
  name: 'Cadeira Gamer',
  price: 899,
  url: 'https://loja.example.com/cadeira',
  store: 'Loja Gamer'
};

function jsonResponse(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    async text() {
      return text;
    }
  };
}

function product(name, extra = {}) {
  return { ...BASE_PRODUCT, name, ...extra };
}

test('normalizeText remove acentos e caixa', () => {
  assert.equal(normalizeText('  Livro Digital  '), 'livro digital');
  assert.equal(normalizeText('HQ MANGÁ #12'), 'hq manga #12');
});

test('hasWord casa palavra inteira, não substring', () => {
  assert.equal(hasWord('livro de fantasia', 'livro'), true);
  assert.equal(hasWord('livros de histórias', 'livro'), false); // plural não é a palavra exata
  assert.equal(hasWord('tablet android', 'livro'), false);
  assert.equal(hasWord('livraria central', 'livro'), false); // livraria não é livro
  assert.equal(hasWord('apostila de concurso', 'apostila'), true);
});

test('bloqueia livro pelo nome', () => {
  const result = analyzeExclusion(product('O Senhor dos Anéis - Livro'));
  assert.equal(result.excluded, true);
  assert.ok(result.reasons.some((reason) => reason.includes('livro')));
  assert.equal(isExcludedProduct(product('O Hobbit - Livro de capa dura')), true);
});

test('bloqueia livro pela categoria mesmo com nome neutro', () => {
  const result = analyzeExclusion(product('Box exclusivo', { category: 'Livros' }));
  assert.equal(result.excluded, true);
});

test('bloqueia e-book e audiolivro pelo título ou descrição', () => {
  assert.equal(isExcludedProduct(product('E-book: O Guia do Mochileiro')), true);
  assert.equal(isExcludedProduct(product('Audiolivro - Dom Casmurro')), true);
  assert.equal(isExcludedProduct(product('Dom Casmurro', { description: 'Edição digital em formato e-book para Kindle' })), true);
  assert.equal(isExcludedProduct(product('Produto genérico', { description: 'Acompanha audiolivro exclusivo' })), true);
});

test('bloqueia mangá, HQ, revista, apostila, enciclopédia e dicionário', () => {
  assert.equal(isExcludedProduct(product('Mangá Naruto Vol. 15')), true);
  assert.equal(isExcludedProduct(product('Batman: A Piada Mortal (HQ)')), true);
  assert.equal(isExcludedProduct(product('Quadrinhos Turma da Mônica capa dura')), true);
  assert.equal(isExcludedProduct(product('Revista Veja - edição semana')), true);
  assert.equal(isExcludedProduct(product('Apostila preparatória ENEM')), true);
  assert.equal(isExcludedProduct(product('Enciclopédia Britannica 2024')), true);
  assert.equal(isExcludedProduct(product('Dicionário de Português')), true);
});

test('permite dispositivo Kindle/tablet/e-reader (hardware)', () => {
  assert.equal(isExcludedProduct(product('Kindle 11ª geração 16GB - leitor digital')), false);
  assert.equal(isExcludedProduct(product('Kindle Paperwhite 8GB', { category: 'Leitores Digitais' })), false);
  assert.equal(isExcludedProduct(product('Kindle Paperwhite com capa', { category: 'Leitores Digitais' })), false);
  assert.equal(isExcludedProduct(product('Tablet Samsung Galaxy Tab S9')), false);
  assert.equal(isExcludedProduct(product('Tablet infantil para desenhar e estudar')), false);
  assert.equal(isExcludedProduct(product('Leitor de e-book Kobo Libra 2')), false);
  assert.equal(isExcludedProduct(product('Capa para Kindle 10ª geração')), false);
  assert.equal(isExcludedProduct(product('Película de vidro para tablet 10,4"')), false);
  assert.equal(isExcludedProduct(product('Acessório Kindle: capa oficial', { category: 'Acessórios' })), false);
});

test('bloqueia e-book destinado ao dispositivo Kindle (arquivo, não hardware)', () => {
  assert.equal(isExcludedProduct(product('Dom Casmurro - Edição Kindle')), true);
  assert.equal(isExcludedProduct(product('Box Harry Potter', { description: 'Versão Kindle completa em e-book' })), true);
  assert.equal(isExcludedProduct(product('Kindle Unlimited - assinatura digital de Livro')), true);
  assert.equal(isExcludedProduct(product('Kindle - edição completa do best-seller'), {}) , true);
  assert.equal(isExcludedProduct(product('Echo Dot + Livro de receitas Kindle')), true);
});

test('permite produto de tecnologia genérico sem termos de livro', () => {
  for (const name of [
    'Headset Gamer 7.1 sem fio',
    'Placa de vídeo RTX 4060',
    'Monitor Gamer 27 polegadas 144Hz',
    'Smartphone Galaxy S24 256GB',
    'Notebook Gamer com teclado RGB',
    'Smartwatch Série 9',
    'Cadeira de escritório ergonômica'
  ]) {
    assert.equal(isExcludedProduct(product(name)), false, name);
  }
});

test('filtro configurável aceita categorias e palavras-chave extras', () => {
  const result = analyzeExclusion(product('Chaveiro personalizado'), {
    extraCategories: ['Papelaria'],
    extraKeywords: ['chaveiro maluco']
  });
  assert.equal(result.excluded, false);
  const category = analyzeExclusion(product('Caneta azul', { category: 'Papelaria' }), {
    extraCategories: ['papelaria'],
    extraKeywords: []
  });
  assert.equal(category.excluded, true);
});

test('createExclusionFilter retorna a análise com a configuração fornecida', () => {
  const filter = createExclusionFilter({ excludedCategories: ['cordas'], excludedKeywords: ['violino'] });
  assert.equal(filter(product('Guitarra', { category: 'Cordas' })).excluded, true);
  assert.equal(filter(product('Notebook')).excluded, false);
});

test('exclusionMessage explica o motivo do bloqueio', () => {
  const message = exclusionMessage(['palavra-chave: livro']);
  assert.match(message, /bloqueado/);
  assert.match(message, /Livros, e-books, audiolivros/);
});

test('applyOfferFilters remove livros antes da seleção', () => {
  const offers = [
    product('Mouse Gamer'),
    product('O Código Da Vinci - Livro Livro'),
    product('Tablet Xiaomi Pad 6'),
    product('Kindle 2022 - leitor digital')
  ];
  const filtered = applyOfferFilters(offers, config());
  assert.deepEqual(filtered.map((offer) => offer.name), ['Mouse Gamer', 'Tablet Xiaomi Pad 6', 'Kindle 2022 - leitor digital']);
});

test('applyOfferFilters usa categoria e descrição extraídas do feed', () => {
  const offers = [
    { ...product('Box 1'), category: 'Livros', description: 'Coleção completa de clássicos' },
    { ...product('Produto ok'), category: 'Eletrônicos', description: 'Acompanha cabo USB-C' }
  ];
  const filtered = applyOfferFilters(offers, config());
  assert.deepEqual(filtered.map((offer) => offer.name), ['Produto ok']);
});

test('parseFeedPayload rejeita livro e mantém tecnologia', () => {
  const parsed = parseFeedPayload({
    offers: [
      {
        name: 'Mangá One Piece vol. 1',
        price: 29.9,
        url: 'https://loja.example.com/op1',
        store: 'Loja',
        category: 'HQs'
      },
      {
        name: 'Echo Dot 5ª geração',
        price: 349,
        url: 'https://loja.example.com/echo',
        store: 'Loja',
        category: 'Eletrônicos'
      }
    ]
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.offers.length, 1);
  assert.equal(parsed.offers[0].name, 'Echo Dot 5ª geração');
  assert.ok(parsed.skipped >= 1);
  assert.ok(parsed.errors.some((entry) => entry.name === 'Mangá One Piece vol. 1'));
});

test('JsonFeedSource bloqueia livros no fetch do feed', async () => {
  const source = new JsonFeedSource('https://example.test/feed.json', {
    fetchImpl: async () =>
      jsonResponse({
        offers: [
          { name: 'Dicionário Michaelis', price: 60, url: 'https://loja.example.com/dic', store: 'Loja' },
          { name: 'Teclado Mecânico', price: 250, url: 'https://loja.example.com/teclado', store: 'Loja' }
        ]
      })
  });
  const result = await source.fetch();
  assert.equal(result.ok, true);
  assert.deepEqual(result.offers.map((offer) => offer.name), ['Teclado Mecânico']);
  assert.equal(result.skipped, 1);
});

test('OfferService.create recusa livro mesmo no cadastro manual', async () => {
  const { OfferService } = await import('../src/services/offer-service.js');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { JsonStorage } = await import('../src/storage/json-storage.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-exclusion-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  const service = new OfferService(storage);

  const blocked = await service.create(product('O Alquimista - Livro'), { actorId: 1 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /bloqueado/i);
  assert.equal((await service.list()).length, 0);

  const ok = await service.create(product('Cadeira Gamer'), { actorId: 1 });
  assert.equal(ok.ok, true);
  assert.equal((await service.list()).length, 1);
});

test('PublishingService.canPublish recusa livro e aceita dispositivo', async () => {
  const service = new PublishingService({});
  const blocked = service.canPublish(product('Harold Bloom - Livro', { status: 'pronta' }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /bloqueado/i);

  const kindleWithoutUrl = service.canPublish(product('Kindle Paperwhite', { url: null, status: 'pronta' }));
  assert.equal(kindleWithoutUrl.ok, false);
  assert.match(kindleWithoutUrl.error, /link/i); // passa o filtro, falha por falta de URL

  const kindleWithUrl = service.canPublish(product('Kindle Paperwhite', { url: 'https://loja.example.com/k', status: 'pronta' }));
  assert.equal(kindleWithUrl.ok, true);
});

test('SchedulerService importa só itens permitidos do feed', async () => {
  const stored = [];
  const rawSource = {
    name: 'feed-teste',
    isConfigured: () => true,
    describe() {
      return { name: this.name, configured: true };
    },
    async fetch() {
      return {
        ok: true,
        offers: [
          { name: 'Ilíada - Livro', price: 50, url: 'https://loja.example.com/iliada', store: 'Loja' },
          { name: 'Notebook Lenovo IdeaPad', price: 2800, url: 'https://loja.example.com/notebook', store: 'Loja' }
        ]
      };
    }
  };
  const scheduler = new SchedulerService({
    config: { ...config(), autoPublish: false, checkIntervalMinutes: 60, maxOffersPerRun: 5, allowedHours: [] },
    sources: [rawSource],
    offerService: {
      async list() {
        return stored.slice();
      },
      async create(input) {
        const offer = { id: `id-${stored.length + 1}`, ...input, status: OFFER_STATUS.READY };
        stored.push(offer);
        return { ok: true, offer };
      }
    },
    publishingService: {
      async publish() {
        return { ok: true };
      }
    }
  });
  const result = await scheduler.importFromSources({ publish: false });
  assert.equal(result.imported, 1);
  assert.equal(result.contentBlocked, 1);
  assert.equal(stored[0].name, 'Notebook Lenovo IdeaPad');
});

test('loadConfig expõe listas de exclusão configuráveis', () => {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100',
    ADMIN_IDS: '1',
    OFFER_EXCLUDE_CATEGORIES: 'Papelaria, Revistas',
    OFFER_EXCLUDE_KEYWORDS: 'historia em quadrinhos'
  });
  assert.deepEqual(cfg.excludedCategories, ['Papelaria', 'Revistas']);
  assert.deepEqual(cfg.excludedKeywords, ['historia em quadrinhos']);
  assert.ok(DEFAULT_EXCLUDED_CATEGORIES.length >= 30);
  assert.ok(DEFAULT_EXCLUDED_KEYWORDS.length >= 20);
});

test('handleOfferLink bloqueia link de livro antes de criar sessão', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { JsonStorage } = await import('../src/storage/json-storage.js');
  const { handleOfferLink } = await import('../src/handlers/message-handler.js');
  const { OfferService } = await import('../src/services/offer-service.js');
  const { TemplateService } = await import('../src/services/template-service.js');
  const { PublishingService } = await import('../src/services/publishing-service.js');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-link-block-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  const offerService = new OfferService(storage);
  const templateService = new TemplateService(storage);
  const sent = [];
  const bot = {
    async sendMessage(chatId, text, extra) {
      sent.push(text);
      return { message_id: sent.length };
    }
  };
  const publishingService = new PublishingService({
    bot,
    config: { channelId: '-100', channelLink: 'https://t.me/bgcpromos' },
    offerService,
    templateService
  });
  const ctx = {
    config: { ...config(), autoPublish: false },
    offerService,
    publishingService,
    templateService,
    linkOptions: {
      lookup: async () => [{ address: '93.184.216.34' }],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return '<meta property="og:title" content="O Senhor dos Anéis - Livro"><meta property="product:price:amount" content="99.90"/>';
        }
      })
    }
  };
  const result = await handleOfferLink(bot, ctx, 7, 7, 'https://loja.example.com/livro');
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.ok(sent.some((text) => /bloqueado/i.test(text)));
});

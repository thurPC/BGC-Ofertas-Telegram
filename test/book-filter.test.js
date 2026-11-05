import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_BOOK_EXCLUDE_KEYWORDS,
  filterNonBookOffers,
  isBookOffer,
  resolveBookFilterConfig
} from '../src/services/book-filter.js';
import { loadConfig } from '../src/config.js';
import { applyOfferFilters } from '../src/sources/source-interface.js';
import { rankOffers, scoreOffer } from '../src/services/offer-scorer.js';
import { SchedulerService } from '../src/services/scheduler-service.js';
import { OfferService } from '../src/services/offer-service.js';
import { JsonStorage } from '../src/storage/json-storage.js';

function techOffer(extra = {}) {
  return {
    name: 'Mouse Gamer RGB',
    price: 89.9,
    previousPrice: 159.9,
    url: extra.url || 'https://s.shopee.com.br/mouse',
    imageUrl: 'https://cf.shopee.com.br/mouse.jpg',
    store: 'Shopee',
    source: 'shopee-open-api',
    commissionRate: 8,
    category: 'informatica',
    ...extra
  };
}

function bookOffer(extra = {}) {
  return {
    name: extra.name || 'Livro O Hobbit edição de bolso',
    price: 29.9,
    previousPrice: 49.9,
    url: extra.url || 'https://s.shopee.com.br/livro',
    imageUrl: 'https://cf.shopee.com.br/livro.jpg',
    store: 'Shopee',
    source: 'shopee-open-api',
    commissionRate: 8,
    category: extra.category || 'livros',
    description: extra.description,
    ...extra
  };
}

test('lista padrão cobre livros, e-books, audiolivros, mangás, HQs e similares', () => {
  const { excludeKeywords } = resolveBookFilterConfig();
  for (const keyword of ['livro', 'ebook', 'audiolivro', 'mangá', 'hq', 'revista', 'apostila', 'enciclopedia', 'dicionario']) {
    assert.ok(
      excludeKeywords.some((item) => item.toLowerCase().includes(keyword.replace('á', 'a')) || item.toLowerCase().includes(keyword)),
      `faltou palavra-chave ${keyword}`
    );
  }
  assert.ok(DEFAULT_BOOK_EXCLUDE_KEYWORDS.length >= 20);
});

test('identifica livros pelo título, categoria e descrição', () => {
  assert.equal(isBookOffer({ name: 'Box Harry Potter livros' }), true);
  assert.equal(isBookOffer({ name: 'Kindle Unlimited e-book romance' }), true);
  assert.equal(isBookOffer({ name: 'Audiolivro Steve Jobs' }), true);
  assert.equal(isBookOffer({ name: 'Mangá One Piece volume 1' }), true);
  assert.equal(isBookOffer({ name: 'HQ Batman Cavalheiro das Trevas' }), true);
  assert.equal(isBookOffer({ name: 'Revista Veja edição especial' }), true);
  assert.equal(isBookOffer({ name: 'Apostila concurso público' }), true);
  assert.equal(isBookOffer({ name: 'Enciclopédia Britânica' }), true);
  assert.equal(isBookOffer({ name: 'Dicionário Aurélio' }), true);
  assert.equal(isBookOffer({ name: 'Caderno universitário', category: 'livros' }), true);
  assert.equal(isBookOffer({ name: 'Item genérico', description: 'e-book em PDF para download' }), true);
});

test('não exclui dispositivos e acessórios de leitura digital', () => {
  assert.equal(isBookOffer({ name: 'Kindle Paperwhite 16GB' }), false);
  assert.equal(isBookOffer({ name: 'Capa para Kindle 11ª geração' }), false);
  assert.equal(isBookOffer({ name: 'Tablet Samsung Galaxy Tab A9' }), false);
  assert.equal(isBookOffer({ name: 'Leitor digital Kobo Clara' }), false);
  assert.equal(isBookOffer({ name: 'iPad 10ª geração 64GB' }), false);
  assert.equal(isBookOffer({ name: 'Mouse Gamer RGB' }), false);
  assert.equal(isBookOffer({ name: 'Camiseta manga longa dry fit' }), false);
});

test('palavras extras da configuração entram no filtro', () => {
  const config = { bookExcludeKeywords: ['almanaque'] };
  assert.equal(isBookOffer({ name: 'Almanaque Abril 2024' }, config), true);
  assert.equal(isBookOffer({ name: 'Mouse Gamer' }, config), false);
});

test('applyOfferFilters remove livros antes da pontuação', () => {
  const filtered = applyOfferFilters(
    [
      techOffer(),
      bookOffer(),
      { name: 'Mangá Naruto', price: 20, url: 'https://s.shopee.com.br/naruto', store: 'Shopee' }
    ],
    { maxPrice: null, minDiscountPercent: null, allowedStores: [] }
  );
  assert.equal(filtered.length, 1);
  assert.match(filtered[0].name, /Mouse Gamer/);
});

test('scoreOffer rejeita livro e aceita produto de tecnologia', () => {
  assert.equal(scoreOffer(bookOffer()).reject, 'book');
  assert.equal(scoreOffer(techOffer()).reject, null);
  const ranked = rankOffers([bookOffer(), techOffer()], { limit: 5, minScore: 20 });
  assert.equal(ranked.selected.length, 1);
  assert.match(ranked.selected[0].name, /Mouse Gamer/);
  assert.ok(ranked.rejected.some((item) => item.reject === 'book'));
});

test('agendador não seleciona nem publica livros e segue com tecnologia', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-books-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  const service = new OfferService(storage);
  const published = [];
  const scheduler = new SchedulerService({
    config: {
      autoPublish: true,
      checkIntervalMinutes: 30,
      maxOffersPerRun: 5,
      publishGapSeconds: 0,
      minOfferScore: 20,
      requireAffiliateLink: false,
      allowedHours: [],
      maxPrice: null,
      minDiscountPercent: null,
      allowedStores: [],
      excludeBooks: true,
      channelId: '-100123',
      token: 'x',
      adminIds: [1n],
      shopeeAppId: '1',
      shopeeAppSecret: 'secret'
    },
    sources: [
      {
        name: 'shopee-open-api',
        isConfigured() {
          return true;
        },
        async fetch() {
          return {
            ok: true,
            offers: [
              bookOffer({ name: 'Livro Clean Code', url: 'https://s.shopee.com.br/clean', externalId: 'book-1' }),
              techOffer({ name: 'Headset Gamer 7.1', url: 'https://s.shopee.com.br/headset', externalId: 'tech-1' })
            ],
            errors: []
          };
        }
      }
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
  assert.equal(result.excludedBooks, 1);
  assert.deepEqual(published, ['Headset Gamer 7.1']);
  const listed = await service.list();
  assert.equal(listed.length, 1);
  assert.match(listed[0].name, /Headset Gamer/);
});

test('loadConfig habilita exclusão de livros por padrão e aceita palavras extras', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100',
    ADMIN_IDS: '1',
    OFFER_BOOK_EXCLUDE_KEYWORDS: 'folheto,almanaque',
    OFFER_BOOK_DEVICE_ALLOW_KEYWORDS: 'remarkable'
  });
  assert.equal(config.excludeBooks, true);
  assert.deepEqual(config.bookExcludeKeywords, ['folheto', 'almanaque']);
  assert.deepEqual(config.bookDeviceAllowKeywords, ['remarkable']);
  const disabled = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100',
    ADMIN_IDS: '1',
    OFFER_EXCLUDE_BOOKS: 'false'
  });
  assert.equal(disabled.excludeBooks, false);
  assert.equal(isBookOffer(bookOffer(), disabled), false);
});

test('filterNonBookOffers mantém somente itens que não são livros', () => {
  const kept = filterNonBookOffers([
    bookOffer({ name: 'Ebook de receitas' }),
    techOffer({ name: 'SSD NVMe 1TB' }),
    { name: 'Leitor de e-books Kindle', url: 'https://s.shopee.com.br/kindle' }
  ]);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((item) => !/ebook de receitas/i.test(item.name)));
});

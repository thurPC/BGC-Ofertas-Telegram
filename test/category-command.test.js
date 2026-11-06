import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStorage } from '../src/storage/json-storage.js';
import {
  CategoryService,
  defaultCategorySettings,
  describeCategories,
  enabledCategories,
  mergeCategorySettings,
  searchKeywordsFromSettings
} from '../src/services/category-service.js';
import { categoryKeyboard, categoryPanel, registerCategoryCallbacks, registerCategoryCommand } from '../src/commands/category.js';
import { SchedulerService } from '../src/services/scheduler-service.js';
import { loadConfig } from '../src/config.js';
import { adminKeyboard } from '../src/commands/admin.js';

async function tempService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-cat-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  const service = new CategoryService(storage, { excludeBooks: true, shopeeKeywords: [] });
  return { dir, storage, service };
}

function fakeBot() {
  const sent = [];
  const handlers = { text: [], message: [], callback: [] };
  const bot = {
    on(event, handler) {
      if (event === 'callback_query') handlers.callback.push(handler);
      else handlers.message.push(handler);
    },
    onText(pattern, handler) {
      handlers.text.push({ pattern, handler });
    },
    async sendMessage(chatId, text, extra) {
      sent.push({ kind: 'text', chatId, text, extra });
      return { message_id: sent.length };
    },
    async answerCallbackQuery() {}
  };
  return { bot, sent, handlers };
}

test('mergeCategorySettings preserva as cinco categorias padrão', () => {
  const settings = mergeCategorySettings();
  assert.deepEqual(settings.enabled, ['tecnologia', 'informatica', 'games', 'eletronicos', 'casa']);
  assert.equal(settings.excludeBooks, true);
  assert.deepEqual(settings.extraKeywords, []);
});

test('desligar categoria e incluir palavra extra persiste no JSON', async () => {
  const { service, storage } = await tempService();
  const toggled = await service.toggle('casa', { actorId: 1 });
  assert.equal(toggled.ok, true);
  assert.equal(toggled.settings.enabled.includes('casa'), false);
  const added = await service.addKeyword('air fryer', { actorId: 1 });
  assert.equal(added.ok, true);
  assert.deepEqual(added.settings.extraKeywords, ['air fryer']);
  const db = await storage.read();
  assert.equal(db.settings.categories.enabled.includes('casa'), false);
  assert.deepEqual(db.settings.categories.extraKeywords, ['air fryer']);
  const restored = await service.reset({ actorId: 1 });
  assert.deepEqual(restored.enabled, defaultCategorySettings().enabled);
});

test('não permite desligar a última categoria', async () => {
  const { service } = await tempService();
  await service.save({ enabled: ['games'] });
  const result = await service.toggle('games');
  assert.equal(result.ok, false);
  assert.match(result.error, /ao menos uma categoria/i);
});

test('searchKeywordsFromSettings usa categorias ativas e extras', () => {
  const keywords = searchKeywordsFromSettings({
    enabled: ['games'],
    extraKeywords: ['cadeira gamer']
  });
  assert.ok(keywords.includes('games'));
  assert.ok(keywords.includes('cadeira gamer'));
  assert.equal(keywords.some((item) => /tecnologia/i.test(item)), false);
  assert.equal(enabledCategories({ enabled: ['games'] }).length, 1);
});

test('describeCategories e teclado mostram o estado atual', () => {
  const settings = mergeCategorySettings({ enabled: ['games', 'tecnologia'], extraKeywords: ['ssd'] });
  const html = describeCategories(settings);
  assert.match(html, /Categorias da automacao/);
  assert.match(html, /Games/);
  assert.match(html, /ssd/);
  const keyboard = categoryKeyboard(settings);
  const labels = keyboard.inline_keyboard.flat().map((item) => item.text);
  assert.ok(labels.some((text) => /Games/.test(text)));
  assert.ok(labels.some((text) => /ssd/.test(text)));
  assert.ok(labels.some((text) => /Adicionar item/.test(text)));
  assert.ok(labels.some((text) => /Ativar/.test(text)));
  assert.ok(labels.some((text) => /Desativar/.test(text)));
  assert.ok(labels.some((text) => /Remover/.test(text)));
});

test('/categoria é restrito a admin e abre o painel', async () => {
  const { service } = await tempService();
  const { bot, sent, handlers } = fakeBot();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100',
    ADMIN_IDS: '7'
  });
  registerCategoryCommand(bot, { config, categoryService: service, scheduler: { applyCategorySettings() {} } });
  const route = handlers.text.find((item) => item.pattern.test('/categoria'));
  assert.ok(route);
  await route.handler({ chat: { id: 1 }, from: { id: 99 }, text: '/categoria' });
  assert.match(sent[0].text, /restrito/i);
  sent.length = 0;
  await route.handler({ chat: { id: 1 }, from: { id: 7 }, text: '/categoria' });
  assert.match(sent[0].text, /Categorias da automacao/);
  assert.ok(sent[0].extra.reply_markup.inline_keyboard.length > 0);
});

test('callback ativa e desativa categoria e aplica no agendador', async () => {
  const { service } = await tempService();
  const { bot, sent, handlers } = fakeBot();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100',
    ADMIN_IDS: '7'
  });
  const applied = [];
  const scheduler = {
    applyCategorySettings(settings) {
      applied.push(settings.enabled.slice());
    }
  };
  registerCategoryCallbacks(bot, { config, categoryService: service, scheduler });
  await handlers.callback[0]({
    id: '1',
    data: 'categoria:off:casa',
    from: { id: 7 },
    message: { chat: { id: 11 } }
  });
  const current = await service.get();
  assert.equal(current.enabled.includes('casa'), false);
  assert.ok(applied.length >= 1);
  assert.match(sent.at(-1).text, /Casa e utilidades/);
});

test('agendador ignora categoria desligada e aplica palavras extras na fonte Shopee', async () => {
  const seen = [];
  const source = {
    name: 'shopee-open-api',
    keywords: [],
    isConfigured() {
      return true;
    },
    applySearchOptions({ keywords }) {
      this.keywords = keywords;
    },
    async fetch() {
      seen.push(this.keywords.slice());
      return {
        ok: true,
        offers: [
          {
            name: 'Air Fryer 4L casa',
            price: 199.9,
            previousPrice: 399.9,
            url: 'https://s.shopee.com.br/air',
            store: 'Shopee',
            source: 'shopee-open-api',
            category: 'casa',
            commissionRate: 8,
            externalId: 'casa-1'
          },
          {
            name: 'Headset Gamer 7.1',
            price: 129.9,
            previousPrice: 249.9,
            url: 'https://s.shopee.com.br/headset',
            store: 'Shopee',
            source: 'shopee-open-api',
            category: 'games',
            commissionRate: 10,
            externalId: 'games-1'
          }
        ],
        errors: []
      };
    }
  };
  const imported = [];
  const scheduler = new SchedulerService({
    config: {
      autoPublish: true,
      checkIntervalMinutes: 30,
      maxOffersPerRun: 5,
      publishGapSeconds: 0,
      minOfferScore: 20,
      requireAffiliateLink: false,
      allowedHours: [],
      shopeeKeywords: ['tecnologia', 'games'],
      excludeBooks: true,
      channelId: '-100',
      token: 'x',
      adminIds: [1n],
      shopeeAppId: '1',
      shopeeAppSecret: 'secret'
    },
    sources: [source],
    offerService: {
      async list() {
        return [];
      },
      async create(input) {
        imported.push(input.name);
        return { ok: true, offer: { id: input.externalId, ...input, status: 'pronta' } };
      }
    },
    publishingService: {
      async publish() {
        return { ok: true };
      }
    },
    sleepFn: async () => undefined
  });
  scheduler.applyCategorySettings({
    enabled: ['games'],
    extraKeywords: ['headset gamer'],
    excludeBooks: true
  });
  const result = await scheduler.run();
  assert.equal(result.ok, true);
  assert.ok(source.keywords.includes('games'));
  assert.ok(source.keywords.includes('headset gamer'));
  assert.equal(source.keywords.includes('tecnologia'), false);
  assert.deepEqual(imported, ['Headset Gamer 7.1']);
});

test('item extra pode ser adicionado, desativado e removido', async () => {
  const { service } = await tempService();
  const added = await service.addKeyword('air fryer');
  assert.equal(added.ok, true);
  assert.equal(added.settings.extras[0].enabled, true);
  const disabled = await service.deactivate('air fryer');
  assert.equal(disabled.settings.extras[0].enabled, false);
  assert.deepEqual(disabled.settings.extraKeywords, []);
  const enabled = await service.activate('air fryer');
  assert.equal(enabled.settings.extras[0].enabled, true);
  const removed = await service.removeKeyword('air fryer');
  assert.equal(removed.settings.extras.length, 0);
});

test('painel admin inclui os atalhos de categorias e horário', () => {
  const buttons = adminKeyboard().inline_keyboard.flat();
  const labels = buttons.map((item) => item.text);
  const callbacks = buttons.map((item) => item.callback_data);
  assert.ok(labels.some((text) => /Categorias/.test(text)));
  assert.ok(labels.some((text) => /Hor[aá]rio/i.test(text)));
  assert.ok(callbacks.includes('cat:home'));
  assert.ok(callbacks.includes('hours:home'));
});

test('categoryPanel não quebra com settings vazias', () => {
  const panel = categoryPanel(null);
  assert.match(panel.html, /Categorias da automacao/);
  assert.ok(panel.keyboard.inline_keyboard.length > 0);
});

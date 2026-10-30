import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseSendMode, formatOfferHtml } from '../src/formatters/offer-message.js';
import { PublishingService } from '../src/services/publishing-service.js';
import { JsonFeedSource, createConfiguredSources } from '../src/sources/json-feed-source.js';
import { applyOfferFilters } from '../src/sources/source-interface.js';
import { SchedulerService } from '../src/services/scheduler-service.js';
import { defaultTemplate } from '../src/services/template-service.js';

const completeOffer = {
  name: 'Mouse Gamer <RGB>',
  price: 149.9,
  previousPrice: 199.9,
  pixPrice: 139.9,
  coupon: 'BGC10',
  couponConditions: 'Uma unidade por CPF',
  imageUrl: 'https://cdn.example.com/mouse.jpg',
  url: 'https://loja.example.com/mouse?afiliado=bgc&utm_source=canal',
  store: 'Loja Gamer',
  status: 'pronta'
};

function templateWithChannel(link = 'https://t.me/bgcpromos') {
  const template = defaultTemplate();
  template.channelLink = link;
  return template;
}

test('renderiza o modelo obrigatório BGC PROMOS na ordem definida', () => {
  const template = templateWithChannel();
  const html = formatOfferHtml(completeOffer, { template, channelLink: template.channelLink });
  const expected = [
    '🔥 Mouse Gamer &lt;RGB&gt;',
    '',
    '💰 R$ 149,90',
    '🎟️ Cupom: BGC10',
    '',
    '🔗 Link do produto:',
    'https://loja.example.com/mouse?afiliado=bgc&amp;utm_source=canal',
    '',
    '👉 Compartilhe com os amigos:',
    'https://t.me/bgcpromos'
  ].join('\n');
  assert.equal(html, expected);
});

test('omite campos opcionais e cupom quando não existem', () => {
  const template = templateWithChannel();
  const html = formatOfferHtml(
    { name: 'Teclado', price: 90, url: 'https://loja.example.com/teclado', store: 'Loja' },
    { template, channelLink: template.channelLink }
  );
  assert.doesNotMatch(html, /Cupom/);
  assert.doesNotMatch(html, /De:/);
  assert.doesNotMatch(html, /PIX:/);
  assert.doesNotMatch(html, /Loja:/);
  assert.match(html, /🔗 Link do produto:\nhttps:\/\/loja\.example\.com\/teclado/);
  assert.match(html, /👉 Compartilhe com os amigos:\nhttps:\/\/t\.me\/bgcpromos/);
});

test('omite o bloco de compartilhamento quando o link do canal não está configurado', () => {
  const template = defaultTemplate();
  const html = formatOfferHtml(completeOffer, { template, channelLink: '' });
  assert.doesNotMatch(html, /Compartilhe/);
  assert.match(html, /🔗 Link do produto:/);
});

test('escolhe sendPhoto quando há imagem e sendMessage quando não há', () => {
  const template = templateWithChannel();
  const withImage = chooseSendMode(completeOffer, formatOfferHtml(completeOffer, { template }));
  assert.equal(withImage.method, 'sendPhoto');
  const noImageOffer = { name: 'X', price: 1, url: 'https://x.test', store: 'Y' };
  const noImage = chooseSendMode(noImageOffer, formatOfferHtml(noImageOffer, { template }));
  assert.equal(noImage.method, 'sendMessage');
});

test('publicação no canal não envia botões inline e usa o modelo com o link do canal', async () => {
  const sent = [];
  const bot = {
    async sendPhoto(chatId, photo, extra) {
      sent.push({ method: 'sendPhoto', chatId, photo, extra });
      return { message_id: 1 };
    },
    async sendMessage(chatId, text, extra) {
      sent.push({ method: 'sendMessage', chatId, text, extra });
      return { message_id: 2 };
    }
  };
  const templateService = { async get() { return templateWithChannel(); } };
  const service = new PublishingService({
    bot,
    config: { channelId: '-100123' },
    offerService: { markPublished: async () => ({ ok: true }) },
    templateService
  });
  const result = await service.publish(completeOffer, { actorId: 1 });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'sendPhoto');
  assert.equal(sent[0].photo, completeOffer.imageUrl);
  assert.equal(sent[0].extra.reply_markup, undefined);
  assert.match(sent[0].extra.caption, /🔥 Mouse Gamer &lt;RGB&gt;/);
  assert.match(sent[0].extra.caption, /💰 R\$ 149,90/);
  assert.match(sent[0].extra.caption, /🎟️ Cupom: BGC10/);
  assert.match(sent[0].extra.caption, /🔗 Link do produto:\nhttps:\/\/loja\.example\.com\/mouse\?afiliado=bgc&amp;utm_source=canal/);
  assert.match(sent[0].extra.caption, /👉 Compartilhe com os amigos:\nhttps:\/\/t\.me\/bgcpromos/);
});

test('preserva integralmente o link de afiliado no texto publicado', async () => {
  const sent = [];
  const bot = {
    async sendPhoto(chatId, photo, extra) {
      sent.push({ extra });
      return { message_id: 1 };
    }
  };
  const service = new PublishingService({
    bot,
    config: { channelId: '-100123' },
    offerService: { markPublished: async () => ({ ok: true }) },
    templateService: { async get() { return templateWithChannel(); } }
  });
  const affiliate = 'https://www.mercadolivre.com.br/sec/abc?matt_word=teste&matt_tool=123';
  await service.publish({ ...completeOffer, url: affiliate }, { actorId: 1 });
  assert.match(sent[0].extra.caption, /matt_word=teste&amp;matt_tool=123/);
});

test('sinaliza revisão administrativa quando não há imagem do produto', async () => {
  const service = new PublishingService({
    bot: { async sendMessage() { return { message_id: 1 }; } },
    config: { channelId: '-100123' },
    offerService: { markPublished: async () => ({ ok: true }) },
    templateService: { async get() { return templateWithChannel(); } }
  });
  const result = await service.publish(
    { ...completeOffer, imageUrl: null },
    { actorId: 1 }
  );
  assert.equal(result.ok, true);
  assert.equal(result.needsImageReview, true);
});

test('recusa publicação sem link válido', () => {
  const service = new PublishingService({ bot: {}, config: { channelId: '-100' } });
  const result = service.canPublish({ name: 'X', price: 10, store: 'Y', status: 'pronta' });
  assert.equal(result.ok, false);
});

test('ausência de fontes automáticas não quebra o modo manual', async () => {
  const sources = createConfiguredSources({ feedUrl: '' });
  assert.equal(sources.length, 0);
  const feed = new JsonFeedSource('');
  assert.equal(feed.isConfigured(), false);
  assert.deepEqual(await feed.fetchOffers(), []);
  const scheduler = new SchedulerService({
    config: { autoPublish: false, checkIntervalMinutes: 60, maxOffersPerRun: 5, allowedHours: [] },
    sources: [],
    offerService: { list: async () => [] },
    publishingService: {}
  });
  const result = await scheduler.run();
  assert.equal(result.ok, true);
  assert.match(result.note, /integração real|nenhuma fonte/i);
});

test('filtros de fonte ignoram ofertas sem link', () => {
  const filtered = applyOfferFilters(
    [
      { name: 'A', price: 10, url: 'https://ok.test', store: 'loja' },
      { name: 'B', price: 10, store: 'loja' }
    ],
    { maxPrice: null, minDiscountPercent: null, allowedStores: [] }
  );
  assert.equal(filtered.length, 1);
});

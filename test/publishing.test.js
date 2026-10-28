import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBuyButton, chooseSendMode, formatOfferHtml } from '../src/formatters/offer-message.js';
import { PublishingService } from '../src/services/publishing-service.js';
import { JsonFeedSource, createConfiguredSources } from '../src/sources/json-feed-source.js';
import { applyOfferFilters } from '../src/sources/source-interface.js';
import { SchedulerService } from '../src/services/scheduler-service.js';

const completeOffer = {
  name: 'Mouse Gamer <RGB>',
  price: 149.9,
  previousPrice: 199.9,
  pixPrice: 139.9,
  coupon: 'BGC10',
  couponConditions: 'Uma unidade por CPF',
  imageUrl: 'https://cdn.example.com/mouse.jpg',
  url: 'https://loja.example.com/mouse',
  store: 'Loja Gamer',
  status: 'pronta'
};

test('formata oferta com imagem e omite campos vazios', () => {
  const html = formatOfferHtml(completeOffer);
  assert.match(html, /OFERTA DO DIA/);
  assert.match(html, /Mouse Gamer &lt;RGB&gt;/);
  assert.match(html, /De: R\$ 199,90/);
  assert.match(html, /PIX: R\$ 139,90/);
  assert.match(html, /BGC10/);
  const withoutOptional = formatOfferHtml({
    name: 'Teclado',
    price: 90,
    url: 'https://loja.example.com/teclado',
    store: 'Loja'
  });
  assert.doesNotMatch(withoutOptional, /De:/);
  assert.doesNotMatch(withoutOptional, /Cupom/);
  assert.doesNotMatch(withoutOptional, /PIX:/);
});

test('escolhe sendPhoto quando há imagem e sendMessage quando não há', () => {
  const withImage = chooseSendMode(completeOffer, formatOfferHtml(completeOffer));
  assert.equal(withImage.method, 'sendPhoto');
  const noImage = chooseSendMode({ name: 'X', price: 1, url: 'https://x.test', store: 'Y' }, formatOfferHtml({ name: 'X', price: 1, url: 'https://x.test', store: 'Y' }));
  assert.equal(noImage.method, 'sendMessage');
});

test('botão de compra usa URL válida', () => {
  const markup = buildBuyButton('https://loja.example.com/mouse');
  assert.equal(markup.inline_keyboard[0][0].url, 'https://loja.example.com/mouse');
  assert.equal(buildBuyButton(null), null);
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

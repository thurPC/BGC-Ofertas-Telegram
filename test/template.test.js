import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BRAND,
  defaultTemplate,
  formatPriceValue,
  mergeTemplate,
  renderOfferMessage
} from '../src/services/template-service.js';
import { TemplateService } from '../src/services/template-service.js';
import { JsonStorage } from '../src/storage/json-storage.js';
import { applyModelInput } from '../src/commands/template.js';

const offer = {
  name: 'Placa de vídeo Gamer',
  price: 1999.9,
  previousPrice: 2499.9,
  pixPrice: 1899.9,
  coupon: 'BGC10',
  couponConditions: 'Somente no PIX',
  imageUrl: 'https://cdn.example.com/gpu.jpg',
  url: 'https://loja.example.com/gpu?afiliado=bgc',
  store: 'Loja Gamer'
};

test('modelo padrão usa a identidade BGC PROMOS e o modelo obrigatório', () => {
  const template = defaultTemplate();
  assert.equal(template.brand, BRAND);
  assert.deepEqual(template.order, ['title', 'price', 'coupon', 'productLink', 'share']);
  assert.equal(template.priceFormat, 'R$ {valor}');
  const message = renderOfferMessage(offer, { template, channelLink: 'https://t.me/bgcpromos' });
  assert.equal(
    message,
    [
      '🔥 Placa de vídeo Gamer',
      '',
      '💰 R$ 1.999,90',
      '🎟️ Cupom: BGC10',
      '',
      '🔗 Link do produto:',
      'https://loja.example.com/gpu?afiliado=bgc',
      '',
      '👉 Compartilhe com os amigos:',
      'https://t.me/bgcpromos'
    ].join('\n')
  );
});

test('formata preço no padrão brasileiro e respeita o formato configurável', () => {
  assert.equal(formatPriceValue(1299.5, 'R$ {valor}'), 'R$ 1.299,50');
  assert.equal(formatPriceValue(1299.5, '{valor}'), '1.299,50');
  assert.equal(formatPriceValue(1299.5, 'A partir de R$ {valor}'), 'A partir de R$ 1.299,50');
});

test('respeita a ordem dos campos e campos opcionais ativos', () => {
  const template = mergeTemplate({
    order: ['title', 'price', 'store', 'productLink'],
    optional: { store: true },
    channelLink: 'https://t.me/bgcpromos'
  });
  const message = renderOfferMessage(offer, { template });
  assert.equal(
    message,
    [
      '🔥 Placa de vídeo Gamer',
      '',
      '💰 R$ 1.999,90',
      '🏪 Loja: Loja Gamer',
      '',
      '🔗 Link do produto:',
      'https://loja.example.com/gpu?afiliado=bgc'
    ].join('\n')
  );
});

test('mergeTemplate ignora campos desconhecidos e restaura padrões ausentes', () => {
  const template = mergeTemplate({ order: ['title', 'price', 'inexistente'], emojis: { title: '⚡', x: '?' } });
  assert.deepEqual(template.order, ['title', 'price']);
  assert.equal(template.emojis.title, '⚡');
  assert.equal(template.emojis.coupon, '🎟️');
  assert.equal(template.emojis.x, undefined);
});

test('applyModelInput valida link, preço, emojis, ordem e opcionais', () => {
  const current = defaultTemplate();
  assert.equal(applyModelInput('link', 'ftp://x', current).ok, false);
  assert.equal(applyModelInput('link', 'https://t.me/bgcpromos', current).patch.channelLink, 'https://t.me/bgcpromos');
  assert.equal(applyModelInput('preco', 'R$ {valor}', current).ok, true);
  assert.equal(applyModelInput('preco', 'R$ fixo', current).ok, false);
  const emoji = applyModelInput('emoji', 'title=⚡', current);
  assert.equal(emoji.patch.emojis.title, '⚡');
  assert.equal(applyModelInput('ordem', 'title,share', current).ok, false);
  assert.equal(applyModelInput('ordem', 'price,title', current).patch.order.join(','), 'price,title');
  assert.equal(applyModelInput('ordem', 'title,price,share', current).patch.order.join(','), 'title,price,share');
  assert.equal(applyModelInput('opcionais', 'nenhum', current).patch.optional.pixPrice, false);
  assert.equal(applyModelInput('opcionais', 'pixPrice', current).patch.optional.pixPrice, true);
});

async function tempService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-template-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  return new TemplateService(storage);
}

test('persiste, atualiza e restaura o modelo padrão', async () => {
  const service = await tempService();
  const initial = await service.get();
  assert.equal(initial.brand, BRAND);

  await service.update({ channelLink: 'https://t.me/bgcpromos', priceFormat: '{valor}' }, { actorId: 1 });
  const updated = await service.get();
  assert.equal(updated.channelLink, 'https://t.me/bgcpromos');
  assert.equal(updated.priceFormat, '{valor}');

  const reset = await service.reset({ actorId: 1 });
  assert.equal(reset.priceFormat, 'R$ {valor}');
  assert.equal(reset.channelLink, '');
  const afterReset = await service.get();
  assert.equal(afterReset.channelLink, '');
});

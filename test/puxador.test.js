import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parsePuxadorSourceChatIds, isAllowedPuxadorSource } from '../src/puxador/source-config.js';
import { parseShopeeChannelPost, puxadorProductKey } from '../src/puxador/shopee-post-parser.js';
import { PuxadorInboxStore } from '../src/puxador/inbox-store.js';
import { registerPuxadorChannelPostHandler } from '../src/puxador/channel-post-handler.js';

test('allowlist aceita somente IDs numéricos explicitamente configurados', () => {
  const ids = parsePuxadorSourceChatIds('-100123, -100456');
  assert.deepEqual(ids, ['-100123', '-100456']);
  assert.equal(isAllowedPuxadorSource(-100123, ids), true);
  assert.equal(isAllowedPuxadorSource(-100999, ids), false);
  assert.equal(isAllowedPuxadorSource('@publicchannel', ids), false);
});

test('parser captura somente publicação com link Shopee e extrai preço/cupom', () => {
  const result = parseShopeeChannelPost({
    message_id: 42,
    date: 1794000000,
    chat: { id: -100123, title: 'Canal autorizado' },
    text: 'SSD NVMe 1TB\\n🔥 R$ 299,90\\nCupom: TESTE50\\nhttps://shopee.com.br/product/123/456'
  });
  assert.equal(result.marketplace, 'Shopee');
  assert.equal(result.price, 299.9);
  assert.equal(result.coupon, 'TESTE50');
  assert.equal(result.shopId, '123');
  assert.equal(result.itemId, '456');
});

test('parser ignora marketplace diferente e mensagens sem link', () => {
  assert.equal(parseShopeeChannelPost({
    message_id: 1, chat: { id: -100123 }, text: 'Oferta https://mercadolivre.com.br/item'
  }), null);
  assert.equal(parseShopeeChannelPost({
    message_id: 2, chat: { id: -100123 }, text: 'Oferta sem link'
  }), null);
});

test('chave do produto consolida URLs com os mesmos IDs Shopee', () => {
  assert.equal(
    puxadorProductKey({ productUrl: 'https://shopee.com.br/product/123/456', shopId: '123', itemId: '456' }),
    'shopee:123:456'
  );
});

test('inbox persiste capturas e consolida o mesmo produto vindo de canais diferentes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-puxador-'));
  const store = new PuxadorInboxStore(path.join(dir, 'inbox.json'));
  await store.init();
  const base = {
    marketplace: 'Shopee',
    productUrl: 'https://shopee.com.br/product/123/456',
    shopId: '123',
    itemId: '456',
    title: 'SSD NVMe 1TB',
    status: 'discovered'
  };
  const first = await store.enqueue({ ...base, sourceChatId: '-1001', sourceMessageId: '10' });
  const second = await store.enqueue({ ...base, sourceChatId: '-1002', sourceMessageId: '20' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const items = await store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].sources.length, 2);
  await fs.rm(dir, { recursive: true, force: true });
});

test('handler ignora canais fora da allowlist e captura canal autorizado', async () => {
  const listeners = {};
  const bot = { on: (event, fn) => { listeners[event] = fn; } };
  const captured = [];
  const inboxStore = { enqueue: async (item) => { captured.push(item); return { ok: true, duplicate: false, item }; } };
  registerPuxadorChannelPostHandler(bot, { allowedChatIds: ['-100123'], inboxStore });
  const message = {
    message_id: 7,
    chat: { id: -100999 },
    text: 'SSD R$ 99,90 https://shopee.com.br/product/123/456'
  };
  await listeners.channel_post(message);
  assert.equal(captured.length, 0);
  message.chat.id = -100123;
  await listeners.channel_post(message);
  assert.equal(captured.length, 1);
});

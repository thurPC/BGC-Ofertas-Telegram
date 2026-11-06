import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalizeUrl,
  findDuplicates,
  identityKeys,
  OfferService,
  OFFER_STATUS
} from '../src/services/offer-service.js';
import { JsonStorage } from '../src/storage/json-storage.js';

function sample(extra = {}) {
  return {
    name: 'Placa de vídeo Gamer',
    price: '1999,90',
    previousPrice: '2499,90',
    pixPrice: '1899,90',
    coupon: 'BGC10',
    couponConditions: 'Somente no PIX',
    imageUrl: 'https://cdn.example.com/gpu.jpg',
    url: 'https://loja.example.com/gpu',
    store: 'Loja Gamer',
    ...extra
  };
}

async function tempService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-offers-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  return { service: new OfferService(storage), dir, storage };
}

test('cria, lista e publica estados da oferta', async () => {
  const { service } = await tempService();
  const created = await service.create(sample(), { actorId: 1 });
  assert.equal(created.ok, true);
  assert.equal(created.offer.status, OFFER_STATUS.READY);
  const listed = await service.list();
  assert.equal(listed.length, 1);
  const published = await service.markPublished(created.offer.id, { actorId: 1 });
  assert.equal(published.offer.status, OFFER_STATUS.PUBLISHED);
  assert.ok(published.offer.publishedAt);
});

test('detecta duplicatas pelo link, ASIN e nome+loja', async () => {
  const existing = [{ id: '1', name: 'Placa de vídeo Gamer', store: 'Loja Gamer', url: 'https://loja.example.com/gpu', price: 10, status: 'pronta' }];
  const dupes = findDuplicates(existing, {
    name: 'Placa de vídeo Gamer',
    store: 'Loja Gamer',
    url: 'https://outra.example/item',
    price: 20
  });
  assert.equal(dupes.length, 1);
  const distinct = findDuplicates(existing, {
    name: 'Headset outro',
    store: 'Outra Loja',
    url: 'https://outra.example/headset',
    price: 20
  });
  assert.equal(distinct.length, 0);
});

test('reconhece o mesmo produto mesmo com parâmetros de afiliado diferentes', () => {
  const existing = [{
    id: 'amz1',
    name: 'Fone Gamer',
    store: 'Amazon Brasil',
    url: 'https://www.amazon.com.br/dp/B09LKE939X?tag=bgc-20',
    status: 'publicada'
  }];
  const sameAsin = findDuplicates(existing, {
    name: 'Fone Gamer Havit',
    store: 'Amazon',
    url: 'https://www.amazon.com.br/Fone-Havit/dp/B09LKE939X?psc=1&tag=outro-20'
  });
  assert.equal(sameAsin.length, 1);
  assert.equal(canonicalizeUrl('https://www.amazon.com.br/dp/B09LKE939X?tag=bgc-20'), 'https://amazon.com.br/dp/B09LKE939X');
  assert.ok([...identityKeys(existing[0])].includes('asin:B09LKE939X'));
});

test('trata o mesmo item Shopee como duplicata mesmo com link, preço ou título novos', () => {
  const existing = [
    {
      id: '1',
      name: 'Mouse Gamer',
      store: 'Loja Gamer',
      url: 'https://s.shopee.com.br/old',
      externalId: 'shopee:20:10',
      price: 99.9,
      status: 'publicada'
    }
  ];
  const dupes = findDuplicates(existing, {
    name: 'Mouse Gamer RGB',
    store: 'Outra Loja',
    url: 'https://s.shopee.com.br/new',
    externalId: 'shopee:20:10',
    price: 79.9
  });
  assert.equal(dupes.length, 1);
});

test('oferta expirada não gera duplicata para recadastro, mas seenOffers impede republicação', async () => {
  const { service } = await tempService();
  const created = await service.create(
    sample({
      name: 'Mouse Gamer',
      url: 'https://s.shopee.com.br/abc',
      store: 'Shopee',
      externalId: 'shopee:20:10'
    })
  );
  assert.equal(created.ok, true);
  await service.remove(created.offer.id);
  const keys = await service.seenKeys();
  assert.equal(keys.has('shopee:20:10'), true, 'histórico de identidade persiste para não republicar');

  const existing = [
    {
      id: '1',
      name: 'Mouse Gamer',
      store: 'Shopee',
      url: 'https://s.shopee.com.br/old',
      externalId: 'shopee:1:99',
      status: 'expirada'
    }
  ];
  const dupes = findDuplicates(existing, {
    name: 'Mouse Gamer novo',
    store: 'Shopee',
    url: 'https://s.shopee.com.br/new',
    externalId: 'shopee:1:99'
  });
  assert.equal(dupes.length, 0, 'ofertas inativas podem ser recadastradas');
});

test('recusa cadastrar de novo a mesma promoção', async () => {
  const { service } = await tempService();
  const first = await service.create(sample());
  assert.equal(first.ok, true);
  const second = await service.create(sample({
    url: 'https://loja.example.com/gpu?utm_source=canal&afiliado=bgc',
    price: '1899,00'
  }));
  assert.equal(second.ok, false);
  assert.equal(second.duplicate, true);
  assert.match(second.error, /já está cadastrada|já foi publicada|já existe/i);
  const listed = await service.list();
  assert.equal(listed.length, 1);
});

test('grava e lê JSON com atualização concorrente serializada', async () => {
  const { service } = await tempService();
  await Promise.all([
    service.create(sample({ name: 'Produto A', url: 'https://loja.example.com/a' })),
    service.create(sample({ name: 'Produto B', url: 'https://loja.example.com/b' })),
    service.create(sample({ name: 'Produto C', url: 'https://loja.example.com/c' }))
  ]);
  const listed = await service.list();
  assert.equal(listed.length, 3);
});

test('restaura banco a partir de backup quando o arquivo principal corrompe', async () => {
  const { storage, dir } = await tempService();
  const file = path.join(dir, 'offers.json');
  const bak = `${file}.bak`;
  await fs.writeFile(
    bak,
    JSON.stringify({
      version: 1,
      offers: [{ id: 'ok', name: 'Backup', status: 'pronta' }],
      history: [],
      settings: { autoPublishEnabled: false }
    }),
    'utf8'
  );
  await fs.writeFile(file, '{quebrado', 'utf8');
  const data = await storage.read();
  assert.equal(data.offers[0].id, 'ok');
});

test('salva rascunho mesmo incompleto', async () => {
  const { service } = await tempService();
  const draft = await service.saveDraft({ name: 'Sem link ainda' }, { actorId: 9 });
  assert.equal(draft.ok, true);
  assert.equal(draft.offer.status, OFFER_STATUS.DRAFT);
  assert.ok(draft.errors.length > 0);
});

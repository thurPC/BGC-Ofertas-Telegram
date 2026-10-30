import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertPublicHttpUrl,
  detectPlatform,
  extractAsin,
  extractFromHtml,
  extractOfferFromLink,
  findCanonicalProductUrl,
  findCoupon,
  hostOf,
  isDomainLikeTitle,
  isPrivateIp,
  requiresAuthorizedPrice,
  resolveStoreFromUrl
} from '../src/services/link-extractor.js';
import {
  analyzeLink,
  extractionSummary,
  invalidLinkMessage,
  missingFieldsMessage,
  missingFieldsPrompt
} from '../src/services/offer-automation.js';
import {
  createExtractionSession,
  missingRequiredFields
} from '../src/handlers/wizard.js';
import { extractLinkFromText, handleOfferLink, getSession, setSession } from '../src/handlers/message-handler.js';
import { registerCallbackHandler } from '../src/handlers/callback-handler.js';
import { OfferService } from '../src/services/offer-service.js';
import { PublishingService } from '../src/services/publishing-service.js';
import { TemplateService } from '../src/services/template-service.js';
import { JsonStorage } from '../src/storage/json-storage.js';
import { loadConfig } from '../src/config.js';

function page(html) {
  return { status: 200, ok: true, headers: { get: () => null }, async text() { return html; } };
}

function fakeOptions(html, { lookup } = {}) {
  return {
    fetchImpl: async () => page(html),
    lookup: lookup || (async () => [{ address: '93.184.216.34' }])
  };
}

function fakeBot() {
  const sent = [];
  const handlers = { message: [], callback: [] };
  const bot = {
    on(event, handler) {
      if (event === 'callback_query') handlers.callback.push(handler);
      else handlers.message.push(handler);
    },
    onText() {},
    async sendMessage(chatId, text, extra) {
      sent.push({ kind: 'text', chatId, text, extra });
      return { message_id: sent.length };
    },
    async sendPhoto(chatId, photo, extra) {
      sent.push({ kind: 'photo', chatId, photo, extra });
      return { message_id: sent.length };
    },
    async answerCallbackQuery() {}
  };
  return { bot, sent, handlers };
}

async function buildCtx(overrides = {}) {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100123',
    ADMIN_IDS: '7',
    BGC_CHANNEL_LINK: 'https://t.me/bgcpromos'
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-link-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  const templateService = new TemplateService(storage);
  const offerService = new OfferService(storage);
  const { bot, sent, handlers } = fakeBot();
  const publishingService = new PublishingService({ bot, config, offerService, templateService });
  const ctx = {
    config,
    offerService,
    publishingService,
    templateService,
    scheduler: { describe: () => ({}) },
    ...overrides
  };
  return { config, ctx, bot, sent, handlers, storage, templateService };
}

test('identifica a plataforma pelo domínio, incluindo encurtadores de afiliado', () => {
  assert.equal(detectPlatform('https://shopee.com.br/product/1/2').id, 'shopee');
  assert.equal(detectPlatform('https://shope.ee/abc').id, 'shopee');
  assert.equal(detectPlatform('https://produto.mercadolivre.com.br/MLB-1').id, 'mercadolivre');
  assert.equal(detectPlatform('https://mercadoliv.re/abc').id, 'mercadolivre');
  assert.equal(detectPlatform('https://www.amazon.com.br/dp/B0X').id, 'amazon');
  assert.equal(detectPlatform('https://amzn.to/3abc').id, 'amazon');
  assert.equal(detectPlatform('https://a.co/d/abc').id, 'amazon');
  assert.equal(detectPlatform('https://loja-qualquer.com/p/1').id, 'generic');
});

test('extrai título e preço de link da Shopee (Open Graph)', () => {
  const html = `<html><head>
    <meta property="og:title" content="Fone Bluetooth Shopee"/>
    <meta property="og:image" content="https://cf.shopee.com.br/fone.jpg"/>
    <meta property="product:price:amount" content="89.90"/>
    <meta property="product:original_price:amount" content="129.90"/>
  </head><body>Use o cupom SHOPEE20</body></html>`;
  const data = extractFromHtml(html, 'https://shopee.com.br/product/1/2', detectPlatform('https://shopee.com.br/product/1/2'));
  assert.equal(data.name, 'Fone Bluetooth Shopee');
  assert.equal(data.price, 89.9);
  assert.equal(data.previousPrice, 129.9);
  assert.equal(data.imageUrl, 'https://cf.shopee.com.br/fone.jpg');
  assert.equal(data.coupon, 'SHOPEE20');
  assert.equal(data.store, 'Shopee');
});

test('extrai título e preço de link do Mercado Livre (JSON-LD)', () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Product","name":"Monitor Gamer 27","image":"https://ml.com/mon.jpg","offers":{"@type":"Offer","price":"1299.00","priceSpecification":{"priceType":"ListPrice","price":"1599.00"}}}</script>
  </head><body></body></html>`;
  const data = extractFromHtml(html, 'https://produto.mercadolivre.com.br/MLB-1', detectPlatform('https://produto.mercadolivre.com.br/MLB-1'));
  assert.equal(data.name, 'Monitor Gamer 27');
  assert.equal(data.price, 1299);
  assert.equal(data.previousPrice, 1599);
  assert.equal(data.imageUrl, 'https://ml.com/mon.jpg');
  assert.equal(data.store, 'Mercado Livre');
});

test('extrai título e preço de link da Amazon e resolve imagem relativa', () => {
  const html = `<html><head>
    <meta property="og:title" content="Echo Dot 5"/>
    <meta property="og:image" content="/images/echo.jpg"/>
    <meta property="og:site_name" content="Amazon"/>
    <meta property="product:price:amount" content="349.00"/>
  </head><body>R$ 349,00</body></html>`;
  const data = extractFromHtml(html, 'https://www.amazon.com.br/dp/B0X', detectPlatform('https://www.amazon.com.br/dp/B0X'));
  assert.equal(data.name, 'Echo Dot 5');
  assert.equal(data.price, 349);
  assert.equal(data.imageUrl, 'https://www.amazon.com.br/images/echo.jpg');
  assert.equal(data.store, 'Amazon Brasil');
});

test('preserva o link de afiliado exatamente como recebido', async () => {
  const affiliate = 'https://www.amazon.com.br/dp/B0X?tag=bgc-20&linkCode=xyz&ref_=abc';
  const result = await extractOfferFromLink(affiliate, fakeOptions('<meta property="og:title" content="Produto"/>'));
  assert.equal(result.ok, true);
  assert.equal(result.offer.url, affiliate);
});

test('link encurtado de afiliado é aceito e o destino é lido sem alterar o link original', async () => {
  const short = 'https://shope.ee/abc123';
  const seen = [];
  const options = {
    lookup: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async (url) => {
      seen.push(url);
      return page('<meta property="og:title" content="Produto Encurtado"/><meta property="product:price:amount" content="19.90"/>');
    }
  };
  const result = await extractOfferFromLink(short, options);
  assert.equal(result.ok, true);
  assert.equal(result.platform.id, 'shopee');
  assert.equal(result.offer.url, short);
  assert.equal(seen[0], short);
});

test('imagem ausente é sinalizada e não é inventada', async () => {
  const html = '<meta property="og:title" content="Sem Foto"/><meta property="product:price:amount" content="10.00"/>';
  const result = await extractOfferFromLink('https://shopee.com.br/product/1/2', fakeOptions(html));
  assert.equal(result.offer.imageUrl, null);
  assert.ok(result.warnings.includes('image-missing'));
});

test('cupom ausente permanece vazio e não é inventado', async () => {
  const html = '<meta property="og:title" content="Sem Cupom"/><meta property="product:price:amount" content="10.00"/>';
  const result = await extractOfferFromLink('https://shopee.com.br/product/1/2', fakeOptions(html));
  assert.equal(result.offer.coupon, null);
  assert.ok(result.warnings.includes('coupon-missing'));
  assert.equal(findCoupon('sem cupom aqui R$ 10,00'), null);
});

test('falha na extração não inventa dados e reporta o motivo', async () => {
  const options = { lookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async () => { throw new Error('boom'); } };
  const result = await extractOfferFromLink('https://shopee.com.br/product/1/2', options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network');
  assert.equal(result.offer, undefined);
  assert.match(invalidLinkMessage(), /não foi possível/i);
});

test('bloqueia endereços internos/privados na obtenção dos dados', async () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.0.5'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('172.20.0.1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);

  for (const url of ['http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/x']) {
    const result = await assertPublicHttpUrl(url);
    assert.equal(result.ok, false, url);
  }

  const dnsRebind = await assertPublicHttpUrl('https://interno.example.com/x', {
    lookup: async () => [{ address: '127.0.0.1' }]
  });
  assert.equal(dnsRebind.ok, false);
});

test('extractLinkFromText aceita apenas mensagem com um único link', () => {
  assert.equal(extractLinkFromText('https://shopee.com.br/product/1/2'), 'https://shopee.com.br/product/1/2');
  assert.equal(extractLinkFromText('olha esse link https://x.test/1'), null);
  assert.equal(extractLinkFromText('https://x.test/1 https://y.test/2'), null);
  assert.equal(extractLinkFromText('sem link'), null);
});

test('sessão de extração pede apenas os campos ausentes, sem reiniciar o cadastro', () => {
  const full = createExtractionSession(1, { name: 'Produto', price: 10, store: 'Loja', url: 'https://x.test/1' });
  assert.deepEqual(full.collect, []);
  assert.equal(full.step, 'preview');

  const partial = createExtractionSession(1, { name: 'Produto', url: 'https://x.test/1' });
  assert.deepEqual(partial.collect, ['price', 'store']);
  assert.equal(partial.step, 'price');
  assert.equal(missingRequiredFields({ name: 'A' }).length, 2);
  assert.match(missingFieldsMessage(['price', 'store']), /preço, loja/);
});

test('fluxo completo: link isolado monta a prévia com o modelo BGC PROMOS e o link do canal', async () => {
  const { ctx, bot, sent } = await buildCtx({
    linkOptions: {
      ...fakeOptions('<meta property="og:title" content="Cadeira Gamer"/><meta property="og:image" content="https://cdn.x/c.jpg"/><meta property="product:price:amount" content="999.90"/><meta property="og:site_name" content="Amazon"/>'),
      authorizedPriceProvider: true
    }
  });
  const result = await handleOfferLink(bot, ctx, 7, 7, 'https://www.amazon.com.br/dp/B0X?tag=bgc-20');
  assert.equal(result.ok, true);
  assert.equal(result.pending, false);
  const preview = sent.at(-1);
  assert.match(preview.text, /🔥 Cadeira Gamer/);
  assert.match(preview.text, /💰 R\$ 999,90/);
  assert.match(preview.text, /🔗 Link do produto:\nhttps:\/\/www\.amazon\.com\.br\/dp\/B0X\?tag=bgc-20/);
  assert.match(preview.text, /👉 Compartilhe com os amigos:\nhttps:\/\/t\.me\/bgcpromos/);
  const buttons = preview.extra.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(buttons.some((text) => /Publicar agora/.test(text)));
  assert.ok(buttons.some((text) => /Salvar rascunho/.test(text)));
  assert.ok(buttons.some((text) => /Corrigir/.test(text)));
  assert.ok(buttons.some((text) => /Cancelar/.test(text)));
  const session = getSession(7);
  assert.equal(session.data.url, 'https://www.amazon.com.br/dp/B0X?tag=bgc-20');
});

test('fluxo parcial: pede somente o campo ausente (preço)', async () => {
  const { ctx, bot, sent } = await buildCtx({
    linkOptions: fakeOptions('<meta property="og:title" content="Teclado"/><meta property="og:site_name" content="Shopee"/>')
  });
  const result = await handleOfferLink(bot, ctx, 7, 7, 'https://shopee.com.br/product/1/2');
  assert.equal(result.pending, true);
  assert.deepEqual(result.missing, ['price']);
  assert.match(sent.at(-1).text, /preço atual/);
});

test('correção manual: link enviado no campo ausente completa a oferta', async () => {
  const { ctx, bot, sent } = await buildCtx({
    linkOptions: fakeOptions('<meta property="og:title" content="Teclado"/><meta property="og:site_name" content="Shopee"/>')
  });
  await handleOfferLink(bot, ctx, 7, 7, 'https://shopee.com.br/product/1/2');
  const session = getSession(7);
  session.data.price = 199.9;
  session.step = 'preview';
  setSession(7, session);
  const { previewPayload, resolvePreviewOptions } = await import('../src/handlers/wizard.js');
  const options = await resolvePreviewOptions(ctx);
  const preview = previewPayload(session, options);
  assert.match(preview.html, /💰 R\$ 199,90/);
  assert.match(preview.html, /🔗 Link do produto:\nhttps:\/\/shopee\.com\.br\/product\/1\/2/);
  assert.ok(sent.length > 0);
});

test('aprovação administrativa: publicar via callback exige admin e não usa botões inline no canal', async () => {
  const { ctx, bot, sent, handlers, config } = await buildCtx();
  registerCallbackHandler(bot, ctx);

  const created = await ctx.offerService.create(
    {
      name: 'Produto Teste',
      price: 49.9,
      url: 'https://shopee.com.br/product/9/9?afiliado=bgc',
      store: 'Shopee',
      imageUrl: 'https://cdn.x/p.jpg'
    },
    { actorId: 7 }
  );
  assert.equal(created.ok, true);
  const offerId = created.offer.id;

  const invoke = async (userId) => {
    const before = sent.length;
    await handlers.callback[0]({
      id: 'cb',
      from: { id: userId },
      message: { chat: { id: 7 } },
      data: `publish:${offerId}`
    });
    return sent.slice(before);
  };

  const denied = await invoke(999);
  assert.ok(denied.length === 0 || denied.every((entry) => !/publicada/i.test(entry.text || '')));

  const allowed = await invoke(7);
  const photo = allowed.find((entry) => entry.kind === 'photo');
  assert.ok(photo, 'publicação deveria enviar foto');
  assert.equal(photo.extra.reply_markup, undefined);
  assert.match(photo.extra.caption, /🔗 Link do produto:\nhttps:\/\/shopee\.com\.br\/product\/9\/9\?afiliado=bgc/);
  assert.match(photo.extra.caption, /👉 Compartilhe com os amigos:\nhttps:\/\/t\.me\/bgcpromos/);
  assert.equal(config.autoPublish, false);
});

test('analyzeLink e resumo de extração expõem apenas dados confirmados', async () => {
  const analysis = await analyzeLink(
    'https://www.amazon.com.br/dp/B0X',
    { ...fakeOptions('<meta property="og:title" content="Produto"/><meta property="product:price:amount" content="5.00"/>'), authorizedPriceProvider: true }
  );
  const summary = extractionSummary(analysis);
  assert.match(summary, /Produto/);
  assert.match(summary, /Imagem: <i>não encontrada<\/i>/);
  assert.match(summary, /Link de afiliado preservado integralmente/);
});

// ---------------------------------------------------------------------------
// Amazon: links curtos, ASIN, marketplace, título real e preço autorizado
// ---------------------------------------------------------------------------

const AMAZON_PRODUCT_HTML = `<html><head>
  <meta property="og:title" content="Fone de Ouvido Gamer Headset Havit H2015D"/>
  <meta property="og:image" content="https://m.media-amazon.com/images/I/havit.jpg"/>
  <meta property="og:site_name" content="Amazon.com.br"/>
  <meta property="og:url" content="https://www.amazon.com.br/dp/B09LKE939X"/>
</head><body>Sem preço divulgado aqui</body></html>`;

function shortLinkOptions(pages, { onFetch } = {}) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (onFetch) onFetch(url);
    const entry = pages[url];
    if (!entry) return { status: 404, ok: false, headers: { get: () => null }, async text() { return ''; } };
    if (entry.redirect) {
      return { status: entry.status ?? 302, ok: false, headers: { get: (name) => (name.toLowerCase() === 'location' ? entry.redirect : null) }, async text() { return ''; } };
    }
    return { status: entry.status ?? 200, ok: (entry.status ?? 200) < 400, headers: { get: () => null }, async text() { return entry.html ?? ''; } };
  };
  return { options: { fetchImpl, lookup: async () => [{ address: '93.184.216.34' }] }, seen };
}

test('reconhece link.amazon como plataforma Amazon', () => {
  assert.equal(detectPlatform('https://link.amazon/B09LKE939X').id, 'amazon');
  assert.equal(detectPlatform('https://amzn.to/3abc').id, 'amazon');
  assert.equal(detectPlatform('https://amzn.com/3abc').id, 'amazon');
  assert.equal(detectPlatform('https://www.amazon.com.br/dp/B09LKE939X').id, 'amazon');
  assert.equal(detectPlatform('https://amazon.com/gp/product/B09LKE939X').id, 'amazon');
  assert.equal(detectPlatform('https://amazon.com.br/dp/B09LKE939X').id, 'amazon');
});

test('extrai o ASIN de /dp/ e /gp/product/', () => {
  assert.equal(extractAsin('https://www.amazon.com.br/dp/B09LKE939X'), 'B09LKE939X');
  assert.equal(extractAsin('https://www.amazon.com/gp/product/B0CX23V2ZK?th=1'), 'B0CX23V2ZK');
  assert.equal(extractAsin('https://www.amazon.com.br/?asin=B0ABC12345'), 'B0ABC12345');
  assert.equal(extractAsin('https://www.amazon.com.br/dp/short'), null);
});

test('resolve a loja pelo domínio final (Amazon Brasil)', () => {
  assert.equal(resolveStoreFromUrl('https://www.amazon.com.br/dp/B09LKE939X', detectPlatform('https://www.amazon.com.br/dp/B09LKE939X')), 'Amazon Brasil');
  assert.equal(resolveStoreFromUrl('https://www.amazon.com/dp/B09LKE939X', detectPlatform('https://www.amazon.com/dp/B09LKE939X')), 'Amazon');
  assert.equal(resolveStoreFromUrl('https://shopee.com.br/product/1/2', detectPlatform('https://shopee.com.br/product/1/2')), 'Shopee');
});

test('nunca aceita o domínio como título do produto', () => {
  assert.equal(isDomainLikeTitle('Amazon.com.br'), true);
  assert.equal(isDomainLikeTitle('Amazon'), true);
  assert.equal(isDomainLikeTitle('www.amazon.com'), true);
  assert.equal(isDomainLikeTitle('amzn.to'), true);
  assert.equal(isDomainLikeTitle('Fone Gamer Havit H2015D'), false);

  const html = '<html><head><meta property="og:title" content="Amazon.com.br"/></head><body></body></html>';
  const data = extractFromHtml(html, 'https://www.amazon.com.br/dp/B09LKE939X', detectPlatform('https://www.amazon.com.br/dp/B09LKE939X'));
  assert.equal(data.name, null);
});

test('link curto link.amazon resolve redirecionamento e lê o produto (Amazon Brasil)', async () => {
  const short = 'https://link.amazon/B09LKE939X';
  const { options, seen } = shortLinkOptions({
    [short]: { redirect: 'https://www.amazon.com.br/dp/B09LKE939X?tag=bgc-20' },
    'https://www.amazon.com.br/dp/B09LKE939X?tag=bgc-20': { html: AMAZON_PRODUCT_HTML }
  });
  const result = await extractOfferFromLink(short, options);
  assert.equal(result.ok, true);
  assert.equal(result.platform.id, 'amazon');
  assert.equal(result.offer.name, 'Fone de Ouvido Gamer Headset Havit H2015D');
  assert.equal(result.offer.store, 'Amazon Brasil');
  assert.equal(result.offer.asin, 'B09LKE939X');
  assert.equal(result.offer.imageUrl, 'https://m.media-amazon.com/images/I/havit.jpg');
  assert.equal(result.offer.url, short, 'o link de afiliado original é preservado');
  assert.equal(result.offer.originalAffiliateUrl, short);
  assert.equal(result.offer.resolvedProductUrl, 'https://www.amazon.com.br/dp/B09LKE939X?tag=bgc-20');
  assert.equal(seen[0], short);
});

test('link curto amzn.to segue página intermediária via canonical até o produto', async () => {
  const short = 'https://amzn.to/3abcXYZ';
  const canonical = 'https://www.amazon.com.br/dp/B0CX23V2ZK';
  const intermediate = `<html><head><link rel="canonical" href="${canonical}"/><meta property="og:title" content="Amazon.com.br"/></head><body>redirecionando</body></html>`;
  const { options } = shortLinkOptions({
    [short]: { html: intermediate },
    [canonical]: { html: '<meta property="og:title" content="Echo Dot 5ª geração"/><meta property="og:image" content="https://m.media-amazon.com/images/I/echo.jpg"/>' }
  });
  const result = await extractOfferFromLink(short, options);
  assert.equal(result.ok, true);
  assert.equal(result.offer.name, 'Echo Dot 5ª geração');
  assert.equal(result.offer.asin, 'B0CX23V2ZK');
  assert.equal(result.offer.store, 'Amazon Brasil');
  assert.equal(result.offer.url, short);
  assert.equal(result.offer.resolvedProductUrl, canonical);
});

test('preço da Amazon não é exibido sem fonte autorizada', async () => {
  const url = 'https://www.amazon.com.br/dp/B09LKE939X';
  const html = '<meta property="og:title" content="Produto"/><meta property="product:price:amount" content="199.90"/><body>R$ 199,90</body>';
  const result = await extractOfferFromLink(url, fakeOptions(html));
  assert.equal(result.offer.price, null);
  assert.equal(result.offer.previousPrice, null);
  assert.ok(result.warnings.includes('price-authorized-only'));
  assert.ok(result.missing.includes('price'));
  assert.equal(requiresAuthorizedPrice('amazon'), true);
  assert.equal(requiresAuthorizedPrice('shopee'), false);
});

test('preço da Amazon é aceito quando há provedor autorizado', async () => {
  const url = 'https://www.amazon.com.br/dp/B09LKE939X';
  const html = '<meta property="og:title" content="Produto"/><meta property="product:price:amount" content="199.90"/>';
  const result = await extractOfferFromLink(url, { ...fakeOptions(html), authorizedPriceProvider: true });
  assert.equal(result.offer.price, 199.9);
  assert.ok(!result.warnings.includes('price-authorized-only'));
});

test('preço de outras lojas continua sendo extraído normalmente', async () => {
  const html = '<meta property="og:title" content="Produto"/><meta property="product:price:amount" content="89.90"/>';
  const result = await extractOfferFromLink('https://shopee.com.br/product/1/2', fakeOptions(html));
  assert.equal(result.offer.price, 89.9);
});

test('página da Amazon bloqueada não inventa dados', async () => {
  const url = 'https://www.amazon.com.br/dp/B09LKE939X';
  const options = {
    lookup: async () => [{ address: '93.184.216.34' }],
    fetchImpl: async () => ({ status: 503, ok: false, headers: { get: () => null }, async text() { return '<html>Robot Check</html>'; } })
  };
  const result = await extractOfferFromLink(url, options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'http-error');
  assert.equal(result.offer, undefined);
});

test('redirecionamento inválido é recusado', async () => {
  const short = 'https://amzn.to/bad';
  const { options } = shortLinkOptions({ [short]: { redirect: 'ftp://evil.example/x' } });
  const result = await extractOfferFromLink(short, options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsafe-url');
});

test('redirecionamento para endereço interno é bloqueado', async () => {
  const short = 'https://amzn.to/internal';
  const { options } = shortLinkOptions({ [short]: { redirect: 'http://169.254.169.254/latest/meta-data' } });
  const result = await extractOfferFromLink(short, options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsafe-url');
});

test('pede somente o preço quando o restante foi identificado (Amazon)', async () => {
  const { ctx, bot, sent } = await buildCtx({
    linkOptions: fakeOptions(AMAZON_PRODUCT_HTML)
  });
  const result = await handleOfferLink(bot, ctx, 7, 7, 'https://www.amazon.com.br/dp/B09LKE939X');
  assert.equal(result.pending, true);
  assert.deepEqual(result.missing, ['price']);
  const summary = sent.find((entry) => /Link analisado/.test(entry.text || ''));
  assert.match(summary.text, /🏪 Loja: Amazon Brasil/);
  assert.match(summary.text, /📦 Produto: Fone de Ouvido Gamer Headset Havit H2015D/);
  assert.match(summary.text, /💰 Preço: <i>precisa ser informado<\/i>/);
  assert.doesNotMatch(summary.text, /Loja: <i>não identificada<\/i>/);
  assert.match(sent.at(-1).text, /Qual é o preço atual/);
  assert.equal(missingFieldsPrompt(['price']), '💰 Qual é o preço atual? Use o formato brasileiro, por exemplo 199,90.');
  assert.doesNotMatch(sent.map((e) => e.text).join('\n'), /Qual a <b>loja<\/b>/);
});

test('compatível com o modelo personalizado ao montar a prévia', async () => {
  const { ctx, bot, sent, templateService } = await buildCtx({
    linkOptions: fakeOptions(AMAZON_PRODUCT_HTML)
  });
  await templateService.update({ labels: { share: 'Compartilhe no grupo' } });
  await handleOfferLink(bot, ctx, 7, 7, 'https://www.amazon.com.br/dp/B09LKE939X');
  const session = getSession(7);
  session.data.price = 149.9;
  session.step = 'preview';
  setSession(7, session);
  const { previewPayload, resolvePreviewOptions } = await import('../src/handlers/wizard.js');
  const preview = previewPayload(session, await resolvePreviewOptions(ctx));
  assert.match(preview.html, /🔥 Fone de Ouvido Gamer Headset Havit H2015D/);
  assert.match(preview.html, /💰 R\$ 149,90/);
  assert.match(preview.html, /Compartilhe no grupo:/);
  assert.match(preview.html, /https:\/\/www\.amazon\.com\.br\/dp\/B09LKE939X/);
  assert.ok(sent.length > 0);
});

test('findCanonicalProductUrl prefere canonical e ignora destinos não-http', () => {
  assert.equal(
    findCanonicalProductUrl('<link rel="canonical" href="https://www.amazon.com.br/dp/B0ABCD1234"/>', 'https://amzn.to/x'),
    'https://www.amazon.com.br/dp/B0ABCD1234'
  );
  assert.equal(
    findCanonicalProductUrl('<meta http-equiv="refresh" content="0; url=https://www.amazon.com.br/dp/B0ABCD1234"/>', 'https://amzn.to/x'),
    'https://www.amazon.com.br/dp/B0ABCD1234'
  );
  assert.equal(findCanonicalProductUrl('<html><body>sem destino</body></html>', 'https://amzn.to/x'), null);
  assert.equal(hostOf('https://www.amazon.com.br/dp/B0X'), 'amazon.com.br');
});

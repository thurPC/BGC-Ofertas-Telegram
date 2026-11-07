import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyProduct } from '../src/deal-engine/classification.js';
import { compareMarkets } from '../src/deal-engine/comparison.js';
import { scoreConfidence } from '../src/deal-engine/confidence.js';
import { applyDiversity, evaluateDedup, significantImprovement } from '../src/deal-engine/dedup.js';
import { mergeDealEngineConfig } from '../src/deal-engine/defaults.js';
import { formatDiagnosticsReport } from '../src/deal-engine/diagnostics.js';
import { identifyProduct, normalizeGtin, sameProductIdentity, variantsCompatible } from '../src/deal-engine/identity.js';
import { dryRunOffer, evaluateOffer, runDealEngine } from '../src/deal-engine/pipeline.js';
import {
  detectArtificialOriginal,
  effectivePrice,
  summarizeHistory
} from '../src/deal-engine/price-intelligence.js';
import { PriceHistoryStore } from '../src/deal-engine/price-store.js';
import { evaluateQualityGate } from '../src/deal-engine/quality-gate.js';
import { revalidateItem } from '../src/deal-engine/queue.js';
import { scoreDeal } from '../src/deal-engine/scoring.js';
import { PRODUCT_FAMILIES } from '../src/deal-engine/taxonomy.js';
import { loadConfig } from '../src/config.js';
import { defaultTemplate } from '../src/services/template-service.js';
import { PublishingService } from '../src/services/publishing-service.js';

function gpu(extra = {}) {
  return {
    name: 'Placa de Vídeo Gigabyte GeForce RTX 5060 8GB GDDR7',
    brand: 'Gigabyte',
    model: 'RTX 5060',
    gtin: '7891234567895',
    mpn: 'GV-N5060WF2-8GD',
    price: 1899.9,
    previousPrice: 2499.9,
    url: 'https://s.shopee.com.br/rtx5060',
    imageUrl: 'https://cf.shopee.com.br/rtx5060.jpg',
    store: 'Shopee',
    source: 'shopee-open-api',
    seller: 'Loja Hardware',
    sales: 320,
    ratingStar: 4.8,
    stock: 12,
    freight: 0,
    category: 'Placas de Vídeo',
    fetchedAt: new Date().toISOString(),
    ...extra
  };
}

function fridge(extra = {}) {
  return {
    name: 'Geladeira Brastemp Frost Free 400 litros 127V',
    brand: 'Brastemp',
    model: 'BRM44',
    gtin: '7891999000013',
    mpn: 'BRM44HK',
    price: 2499,
    previousPrice: 3299,
    url: 'https://www.mercadolivre.com.br/p/MLB12345678',
    store: 'Mercado Livre',
    source: 'json-feed',
    stock: 3,
    category: 'Geladeiras',
    fetchedAt: new Date().toISOString(),
    ...extra
  };
}

function historyAround(price, days = [90, 60, 45, 30, 21, 14, 7, 3, 1]) {
  const now = Date.now();
  return days.map((day, index) => ({
    at: new Date(now - day * 24 * 60 * 60 * 1000).toISOString(),
    finalPrice: price + (index % 2 === 0 ? 80 : 40),
    price: price + (index % 2 === 0 ? 80 : 40)
  }));
}

test('identifica produto por GTIN e não mistura variantes de GPU', () => {
  const a = identifyProduct(gpu());
  const b = identifyProduct(gpu({ name: 'RTX 5060 Ti 16GB', model: 'RTX 5060 Ti', gtin: '7891234567801', mpn: 'TI16' }));
  assert.equal(a.method, 'gtin');
  assert.equal(normalizeGtin(a.gtin), '7891234567895');
  assert.equal(sameProductIdentity(a, b), false);
  assert.equal(variantsCompatible(a, b), false);
});

test('identifica por MPN e distingue Ryzen 5 5600 de 5600X', () => {
  const base = identifyProduct({
    name: 'Processador AMD Ryzen 5 5600',
    brand: 'AMD',
    mpn: '100-100000927BOX',
    url: 'https://loja.example.com/5600'
  });
  const plus = identifyProduct({
    name: 'Processador AMD Ryzen 5 5600X',
    brand: 'AMD',
    mpn: '100-100000065BOX',
    url: 'https://loja.example.com/5600x'
  });
  assert.equal(base.method, 'mpn');
  assert.equal(sameProductIdentity(base, plus), false);
  assert.match(base.model || '', /5600/);
  assert.match(plus.model || '', /5600x/i);
});

test('distingue i5-12400 de i5-12400F, SSD 1TB de 2TB, DDR4 de DDR5', () => {
  const i5 = identifyProduct({ name: 'Intel Core i5-12400', brand: 'Intel' });
  const i5f = identifyProduct({ name: 'Intel Core i5-12400F', brand: 'Intel' });
  assert.equal(variantsCompatible(i5, i5f), false);

  const ssd1 = identifyProduct({ name: 'SSD Kingston NV2 1TB NVMe', brand: 'Kingston' });
  const ssd2 = identifyProduct({ name: 'SSD Kingston NV2 2TB NVMe', brand: 'Kingston' });
  assert.equal(ssd1.variant.capacityTb, 1);
  assert.equal(ssd2.variant.capacityTb, 2);
  assert.equal(variantsCompatible(ssd1, ssd2), false);

  const ddr4 = identifyProduct({ name: 'Memória Corsair Vengeance 16GB DDR4 3200', brand: 'Corsair' });
  const ddr5 = identifyProduct({ name: 'Memória Corsair Vengeance 16GB DDR5 5200', brand: 'Corsair' });
  assert.equal(ddr4.variant.memoryType, 'ddr4');
  assert.equal(ddr5.variant.memoryType, 'ddr5');
  assert.equal(variantsCompatible(ddr4, ddr5), false);
});

test('classifica computadores, eletrodomésticos e desconhecidos sem depender só do título isolado', () => {
  const computer = classifyProduct(gpu(), identifyProduct(gpu()));
  const appliance = classifyProduct(fridge(), identifyProduct(fridge()));
  const unknown = classifyProduct({ name: 'Produto misterioso XYZ', url: 'https://loja.example.com/x', price: 10 });
  assert.equal(computer.taxonomyId, 'gpus');
  assert.equal(computer.family, PRODUCT_FAMILIES.COMPUTERS);
  assert.equal(appliance.taxonomyId, 'refrigerators');
  assert.equal(appliance.family, PRODUCT_FAMILIES.APPLIANCES);
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.eligible, false);
});

test('rejeita livros, publicações e não publica categoria unknown', () => {
  const book = classifyProduct({ name: 'Livro Clean Code', category: 'Livros', url: 'https://loja.example.com/livro', price: 50 });
  const magazine = classifyProduct({ name: 'Revista de informática edição 12', category: 'Revistas' });
  assert.equal(book.eligible, false);
  assert.equal(book.family, PRODUCT_FAMILIES.INELIGIBLE);
  assert.equal(magazine.eligible, false);
  const unknownEval = evaluateOffer({ name: 'Coisa indefinida', price: 20, url: 'https://loja.example.com/x' });
  assert.equal(unknownEval.gate.ok, false);
  assert.ok(unknownEval.gate.reasons.includes('unknown-category') || unknownEval.gate.reasons.includes('unidentified-product'));
});

test('jogos de tabuleiro não são tratados como livro, mas só passam se a categoria estiver habilitada', () => {
  const board = classifyProduct({ name: 'Jogo de tabuleiro Catan', category: 'Jogos de tabuleiro' });
  assert.notEqual(board.family, PRODUCT_FAMILIES.INELIGIBLE);
  assert.equal(board.eligible, false);
});

test('histórico 7/30/90, mediana e mínima não usam o preço original anunciado', () => {
  const snapshots = historyAround(2000);
  snapshots.push({ at: new Date().toISOString(), finalPrice: 1899.9, price: 1899.9 });
  const stats = summarizeHistory(snapshots, new Date());
  assert.ok(stats.mean7 > 0);
  assert.ok(stats.mean30 > 0);
  assert.ok(stats.mean90 > 0);
  assert.ok(stats.median30 > 0);
  assert.ok(stats.median90 > 0);
  assert.ok(stats.min <= stats.median30);
  const offer = gpu({ previousPrice: 9000, price: 1899.9 });
  const artificial = detectArtificialOriginal(offer, stats);
  assert.equal(artificial.artificial, true);
});

test('preço efetivo considera frete e cupom reais, sem inventar valores', () => {
  assert.equal(effectivePrice({ price: 100, freight: 20, couponDiscountAmount: 10 }), 110);
  assert.equal(effectivePrice({ price: 100, pixPrice: 90 }), 90);
  assert.equal(effectivePrice({ price: null }), null);
});

test('comparação só ocorre entre o mesmo modelo e variante', () => {
  const left = evaluateOffer(gpu({ price: 1800, source: 'json-feed', url: 'https://loja.example.com/a' }), {
    requireAffiliateLink: false,
    config: { minDealScore: 0, minConfidence: 0 }
  });
  const rightSame = evaluateOffer(gpu({ price: 2100, source: 'shopee-open-api', url: 'https://s.shopee.com.br/b' }), {
    requireAffiliateLink: false,
    config: { minDealScore: 0, minConfidence: 0 }
  });
  const ti = evaluateOffer(gpu({ name: 'RTX 5060 Ti 16GB', model: 'RTX 5060 Ti', gtin: '7891234567801', mpn: 'TI16', url: 'https://s.shopee.com.br/ti' }), {
    requireAffiliateLink: false,
    config: { minDealScore: 0, minConfidence: 0 }
  });
  const comparison = compareMarkets(left, [rightSame, ti]);
  assert.equal(comparison.comparableCount, 1);
  assert.equal(comparison.isCheapest, true);
});

test('Deal Score usa evidência real e não dá nota máxima a campo vazio; comissão não soma', () => {
  const stats = summarizeHistory(historyAround(2400).concat([{ at: new Date().toISOString(), finalPrice: 1899.9 }]));
  const scored = scoreDeal(
    {
      offer: gpu({ commissionRate: 80 }),
      stats,
      comparison: { comparableCount: 2, isCheapest: true, percentile: 100, savings: 200 },
      finalPrice: 1899.9
    }
  );
  assert.ok(scored.dealScore > 50);
  assert.ok(scored.dealScore <= 100);
  assert.equal(Object.keys(scored.breakdown).includes('commission'), false);
  const empty = scoreDeal({ offer: { name: 'X', price: 10, url: 'https://s.shopee.com.br/x' }, stats: { insufficient: true, sampleSize: 0 } });
  assert.ok(empty.dealScore < scored.dealScore);
  assert.equal(empty.breakdown.historicalDiscount.points, 0);
});

test('Confidence Score é independente e bloqueia identidade fraca mesmo com desconto alto', () => {
  const weak = evaluateOffer({
    name: 'Promoção incrível 80% off',
    price: 99,
    previousPrice: 800,
    url: 'https://loja.example.com/x'
  });
  const confidence = scoreConfidence(weak);
  assert.ok(confidence.confidenceScore < 90);
  assert.equal(weak.gate.ok, false);
});

test('quality gate falha fechado sem identidade, estoque, link ou score', () => {
  const gate = evaluateQualityGate({
    offer: { name: 'X', price: null, url: 'ftp://x' },
    identity: { method: 'uncertain', uncertain: true },
    classification: { unknown: true, eligible: false },
    deal: { dealScore: 10 },
    confidence: { confidenceScore: 10 }
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('unidentified-product'));
  assert.ok(gate.reasons.includes('invalid-price'));
});

test('deduplicação, cooldown e diversidade entre famílias', () => {
  const item = evaluateOffer(gpu(), { requireAffiliateLink: false, config: { minDealScore: 0, minConfidence: 0 } });
  const dup = evaluateDedup(item, {
    config: mergeDealEngineConfig({ cooldownHours: 24 }),
    publications: [{ identityKey: item.identity.key, at: new Date().toISOString(), price: 1899.9, dealScore: 80 }]
  });
  assert.equal(dup.duplicate, true);
  assert.equal(
    significantImprovement({ finalPrice: 1500, deal: { dealScore: 90 } }, { price: 1899.9, dealScore: 80 }, { significantDropPercent: 8 }),
    true
  );
  const mixed = applyDiversity(
    [
      { identity: { brand: 'gigabyte' }, classification: { family: PRODUCT_FAMILIES.COMPUTERS } },
      { identity: { brand: 'gigabyte' }, classification: { family: PRODUCT_FAMILIES.COMPUTERS } },
      { identity: { brand: 'gigabyte' }, classification: { family: PRODUCT_FAMILIES.COMPUTERS } },
      { identity: { brand: 'brastemp' }, classification: { family: PRODUCT_FAMILIES.APPLIANCES } }
    ],
    { maxPerBrandPerCycle: 2, maxPerFamilyShare: 0.7 }
  );
  assert.ok(mixed.length <= 3);
});

test('expiração e revalidação removem oferta cujo preço subiu ou ficou sem estoque', () => {
  const queued = { finalPrice: 100, price: 100 };
  assert.equal(revalidateItem(queued, { price: 130, url: 'https://loja.example.com/x' }).ok, false);
  assert.equal(revalidateItem(queued, { price: 100, stock: 0, url: 'https://loja.example.com/x' }).ok, false);
  assert.equal(revalidateItem(queued, null).status, 'expired');
  assert.equal(revalidateItem(queued, { price: 100, stock: 4, url: 'https://loja.example.com/x' }).ok, true);
});

test('histórico persiste após reinício e a retenção não apaga a janela recente', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-price-'));
  const file = path.join(dir, 'price-history.json');
  const store = new PriceHistoryStore(file);
  await store.init();
  const identity = identifyProduct(gpu());
  await store.record(gpu(), identity);
  const again = new PriceHistoryStore(file);
  await again.init();
  const stats = await again.stats(identity.key);
  assert.ok(stats.sampleSize >= 1);
  await again.prune(365);
  const kept = await again.history(identity.key);
  assert.ok(kept.length >= 1);
});

test('pipeline dry-run não publica e explica rejeição; fail-closed sem evidência', async () => {
  const result = await runDealEngine(
    [
      gpu(),
      { name: 'Livro de hardware', price: 20, url: 'https://loja.example.com/livro', category: 'Livros' },
      gpu({ name: 'RTX 5060 Ti', model: 'RTX 5060 Ti', gtin: '7891234567801', mpn: 'TI', url: 'https://s.shopee.com.br/ti', price: 4000 })
    ],
    {
      config: mergeDealEngineConfig({ minDealScore: 75, minConfidence: 90 }),
      requireAffiliateLink: false,
      statsByKey: {}
    }
  );
  assert.equal(result.approved.length, 0);
  assert.ok(result.rejected.length >= 1);
  const preview = dryRunOffer(result.evaluated[0], { template: defaultTemplate() });
  assert.equal(typeof preview.approved, 'boolean');
  assert.ok(preview.insufficientHistory);
  assert.ok(Array.isArray(preview.reasons));
});

test('publicação Telegram usa mock, é idempotente e falha fechada com auto-publish desligado', async () => {
  const sent = [];
  const bot = {
    async sendPhoto() {
      throw new Error('não deveria enviar foto neste teste');
    },
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    }
  };
  const service = new PublishingService({
    bot,
    config: { channelId: '-100', autoPublish: false },
    offerService: {
      async list() {
        return [];
      },
      async markPublished() {
        return { ok: true };
      }
    }
  });
  const offer = {
    name: 'Headset Gamer',
    price: 129.9,
    url: 'https://s.shopee.com.br/abc',
    status: 'pronta',
    source: 'manual'
  };
  const first = await service.publish(offer, { actorId: 'test' });
  assert.equal(first.ok, true);
  assert.equal(sent.length, 1);
  const second = await service.publish({ ...offer, status: 'publicada' }, { actorId: 'test' });
  assert.equal(second.ok, false);
  assert.equal(sent.length, 1);
});

test('fonte que falha não inventa ofertas e concorrência do ciclo é serializada pelo lock', async () => {
  const result = await runDealEngine(undefined, { config: mergeDealEngineConfig() });
  assert.equal(result.evaluated.length, 0);
  assert.equal(result.approved.length, 0);
});

test('configuração padrão mantém auto-publish desligado e Deal Engine observável', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100',
    ADMIN_IDS: '1'
  });
  assert.equal(config.autoPublish, false);
  assert.equal(config.checkIntervalMinutes, 30);
  assert.equal(config.dealEngine.enabled, true);
  assert.equal(config.dealEngine.controlSelection, false);
  assert.equal(config.dealEngine.minDealScore, 75);
  assert.equal(config.dealEngine.minConfidence, 90);
});

test('relatório de diagnóstico não inclui segredos', () => {
  const html = formatDiagnosticsReport({
    discovered: 4,
    identified: 2,
    classified: 2,
    rejected: 2,
    ranked: 1,
    queued: 1,
    published: 0,
    expired: 0,
    quarantined: 1,
    sourceFailures: 0,
    durationMs: 12,
    rejectionReasons: { 'low-confidence': 2 }
  });
  assert.match(html, /Descobertos: 4/);
  assert.doesNotMatch(html, /SHOPEE_APP|APP_SECRET|password=/i);
});

test('geladeira 400L / 500L, lavadora 12kg / 17kg, ar 9000 / 18000 BTU e 127V / 220V são variantes distintas', () => {
  const g400 = identifyProduct(fridge());
  const g500 = identifyProduct(fridge({ name: 'Geladeira Brastemp 500 litros 127V', model: 'BRM50' }));
  assert.equal(g400.variant.capacityL, 400);
  assert.equal(g500.variant.capacityL, 500);
  assert.equal(variantsCompatible(g400, g500), false);

  const w12 = identifyProduct({ name: 'Máquina de lavar Electrolux 12 kg', brand: 'Electrolux' });
  const w17 = identifyProduct({ name: 'Máquina de lavar Electrolux 17 kg', brand: 'Electrolux' });
  assert.equal(w12.variant.capacityKg, 12);
  assert.equal(w17.variant.capacityKg, 17);

  const ac9 = identifyProduct({ name: 'Ar-condicionado Midea 9.000 BTUs 220V', brand: 'Midea' });
  const ac18 = identifyProduct({ name: 'Ar-condicionado Midea 18.000 BTUs 220V', brand: 'Midea' });
  assert.equal(ac9.variant.btu, 9000);
  assert.equal(ac18.variant.btu, 18000);
  assert.equal(variantsCompatible(ac9, ac18), false);

  const v127 = identifyProduct(fridge({ name: 'Geladeira Brastemp 400 litros 127V' }));
  const v220 = identifyProduct(fridge({ name: 'Geladeira Brastemp 400 litros 220V' }));
  assert.equal(v127.variant.voltage, '127');
  assert.equal(v220.variant.voltage, '220');
  assert.equal(variantsCompatible(v127, v220), false);
});

test('monitor Full HD não equivale a Quad HD', () => {
  const fhd = identifyProduct({ name: 'Monitor Gamer 27 Full HD 165Hz', brand: 'LG' });
  const qhd = identifyProduct({ name: 'Monitor Gamer 27 Quad HD 165Hz', brand: 'LG' });
  assert.equal(fhd.variant.resolution, 'full hd');
  assert.equal(qhd.variant.resolution, 'quad hd');
  assert.equal(variantsCompatible(fhd, qhd), false);
});

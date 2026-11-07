import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { loadConfig, PROJECT_ROOT } from '../config.js';
import { defaultTemplate } from '../services/template-service.js';
import { createShopeeAffiliateClient } from '../services/shopee-affiliate-client.js';
import { createConfiguredSources } from '../sources/json-feed-source.js';
import { mergeDealEngineConfig } from './defaults.js';
import { dryRunOffer, runDealEngine } from './pipeline.js';
import { PriceHistoryStore } from './price-store.js';

function parseArgs(argv) {
  const args = { file: null, dataDir: null, limit: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--file' || item === '-f') args.file = argv[i + 1];
    if (item === '--data-dir') args.dataDir = argv[i + 1];
    if (item === '--limit') args.limit = Number.parseInt(argv[i + 1], 10) || 20;
  }
  return args;
}

function extractOffers(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.offers)) return payload.offers;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

export async function collectDryRunOffers(sources = []) {
  const collected = [];
  const sourceErrors = [];
  const sourceReports = [];
  for (const source of sources) {
    const name = source?.name || 'unknown';
    const configured = typeof source.isConfigured === 'function' ? source.isConfigured() : true;
    if (!configured) {
      sourceReports.push({ name, configured: false, ok: false, fetched: 0, reason: 'not-configured' });
      continue;
    }
    let result;
    try {
      result = typeof source.fetch === 'function'
        ? await source.fetch()
        : { ok: true, offers: await source.fetchOffers(), errors: [], reason: null };
    } catch (error) {
      result = {
        ok: false,
        offers: [],
        errors: [error?.message || 'Falha ao consultar a fonte.'],
        reason: 'network'
      };
    }
    if (!result?.ok) {
      sourceErrors.push({
        source: name,
        reason: result?.reason || 'source-error',
        errors: result?.errors || []
      });
      sourceReports.push({
        name,
        configured: true,
        ok: false,
        fetched: 0,
        reason: result?.reason || 'source-error'
      });
      continue;
    }
    const offers = Array.isArray(result.offers) ? result.offers : [];
    collected.push(...offers);
    sourceReports.push({ name, configured: true, ok: true, fetched: offers.length, reason: null });
  }
  return { collected, sourceErrors, sourceReports };
}

function resolveSources({ sources, config, sourceOptions } = {}) {
  if (Array.isArray(sources)) return sources;
  const resolved = config || loadConfig();
  const options = sourceOptions || {};
  const shopeeClient = options.shopeeClient || createShopeeAffiliateClient(resolved);
  return createConfiguredSources(resolved, { ...options, shopeeClient });
}

export async function runDryRun({
  file,
  dataDir,
  limit,
  priceStore,
  config,
  sources,
  sourceOptions,
  requireAffiliateLink
} = {}) {
  const resolvedConfig = config || loadConfig();
  const origin = file ? 'file' : 'configured-sources';
  let offers = [];
  let sourceErrors = [];
  let sourceReports = [];

  if (file) {
    const raw = await fs.readFile(path.resolve(file), 'utf8');
    offers = extractOffers(JSON.parse(raw));
    sourceReports.push({ name: 'file', configured: true, ok: true, fetched: offers.length, reason: null });
  } else {
    const resolvedSources = resolveSources({ sources, config: resolvedConfig, sourceOptions });
    const configured = resolvedSources.filter((source) =>
      typeof source.isConfigured === 'function' ? source.isConfigured() : true
    );
    if (!configured.length) {
      return {
        ok: false,
        error:
          'Nenhuma fonte configurada. Defina OFFER_FEED_URL e/ou credenciais Shopee no ambiente, ou use --file com um dump autorizado.',
        origin,
        telegramSent: false,
        sourceErrors: [],
        sources: resolvedSources.map((source) => source.describe?.() || { name: source.name, configured: false })
      };
    }
    const collected = await collectDryRunOffers(resolvedSources);
    offers = collected.collected;
    sourceErrors = collected.sourceErrors;
    sourceReports = collected.sourceReports;
  }

  const store =
    priceStore ||
    PriceHistoryStore.fromConfig({
      dataDir: path.resolve(dataDir || resolvedConfig.dataDir || 'data')
    });
  await store.init();
  const affiliateRequired =
    requireAffiliateLink != null ? requireAffiliateLink : file ? false : Boolean(resolvedConfig.requireAffiliateLink);
  const result = await runDealEngine(offers, {
    config: mergeDealEngineConfig({ ...resolvedConfig.dealEngine, controlSelection: true }),
    priceStore: store,
    limit,
    requireAffiliateLink: affiliateRequired
  });
  const template = defaultTemplate();
  const rows = result.evaluated.map((item) => dryRunOffer(item, { template }));
  return {
    ok: true,
    origin,
    fetched: offers.length,
    approved: result.approved.length,
    rejected: result.rejected.length,
    report: result.report,
    results: rows,
    sourceErrors,
    sources: sourceReports,
    telegramSent: false,
    note: 'Dry-run: nenhuma mensagem foi enviada ao Telegram.'
  };
}

async function main() {
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });
  const args = parseArgs(process.argv.slice(2));
  const result = await runDryRun(args);
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && pathToFileURL(invoked).href === pathToFileURL(thisFile).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

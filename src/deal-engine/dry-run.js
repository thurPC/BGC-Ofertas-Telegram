import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultTemplate } from '../services/template-service.js';
import { mergeDealEngineConfig } from './defaults.js';
import { dryRunOffer, runDealEngine } from './pipeline.js';
import { PriceHistoryStore } from './price-store.js';

function parseArgs(argv) {
  const args = { file: null, dataDir: 'data', limit: 20 };
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

export async function runDryRun({ file, dataDir, limit, priceStore } = {}) {
  if (!file) {
    return { ok: false, error: 'Informe um arquivo JSON com --file.' };
  }
  const raw = await fs.readFile(path.resolve(file), 'utf8');
  const offers = extractOffers(JSON.parse(raw));
  const store = priceStore || PriceHistoryStore.fromConfig({ dataDir: path.resolve(dataDir || 'data') });
  await store.init();
  const result = await runDealEngine(offers, {
    config: mergeDealEngineConfig({ controlSelection: true }),
    priceStore: store,
    limit,
    requireAffiliateLink: false
  });
  const template = defaultTemplate();
  const rows = result.evaluated.map((item) => dryRunOffer(item, { template }));
  return {
    ok: true,
    fetched: offers.length,
    approved: result.approved.length,
    rejected: result.rejected.length,
    report: result.report,
    results: rows,
    note: 'Dry-run: nenhuma mensagem foi enviada ao Telegram.'
  };
}

async function main() {
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

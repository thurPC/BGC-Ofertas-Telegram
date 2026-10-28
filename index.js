import './src/preload.js';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { assertRuntimeConfig, loadConfig, PROJECT_ROOT } from './src/config.js';
import { createBot, stopBot } from './src/bot.js';
import { logger } from './src/logger.js';
import { registerPublicCommands } from './src/commands/public.js';
import { registerMessageHandler } from './src/handlers/message-handler.js';
import { registerCallbackHandler } from './src/handlers/callback-handler.js';
import { OfferService } from './src/services/offer-service.js';
import { PublishingService } from './src/services/publishing-service.js';
import { SchedulerService } from './src/services/scheduler-service.js';
import { JsonStorage } from './src/storage/json-storage.js';
import { createConfiguredSources } from './src/sources/json-feed-source.js';

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const LOCK_FILE = path.join(PROJECT_ROOT, 'data', 'bot.pid');
let bot;
let scheduler;
let shuttingDown = false;

function acquireInstanceLock() {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const previous = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
    if (Number.isInteger(previous)) {
      try {
        process.kill(previous, 0);
        throw new Error(
          `Outra instância do BGC Ofertas já está em execução (pid ${previous}). Encerrando para evitar polling duplicado.`
        );
      } catch (error) {
        if (error.code !== 'ESRCH' && error.message.includes('já está em execução')) throw error;
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'w' });
}

function releaseInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const stored = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
      if (stored === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // ignore
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Encerrando (${signal}).`);
  if (scheduler) scheduler.stop();
  await stopBot(bot);
  releaseInstanceLock();
  process.exit(0);
}

async function main() {
  const config = loadConfig(process.env);
  if (config.missing.length) {
    logger.error(
      `Configuração incompleta. Variáveis ausentes ou inválidas: ${config.missing.join(', ')}.`
    );
    logger.error('Copie .env.example para .env e preencha os valores. Nenhum segredo foi exibido.');
    process.exit(1);
  }
  assertRuntimeConfig(config);
  acquireInstanceLock();

  const storage = new JsonStorage(path.join(config.dataDir, 'offers.json'));
  await storage.init();

  const offerService = new OfferService(storage);
  bot = createBot(config.token, { polling: true });
  const publishingService = new PublishingService({ bot, config, offerService });
  const sources = createConfiguredSources(config);
  scheduler = new SchedulerService({
    config,
    sources,
    offerService,
    publishingService
  });

  const ctx = { config, offerService, publishingService, scheduler };

  registerPublicCommands(bot);
  registerMessageHandler(bot, ctx);
  registerCallbackHandler(bot, ctx);

  await bot.setMyCommands([
    { command: 'start', description: 'Apresentação do BGC Ofertas' },
    { command: 'ajuda', description: 'Lista de comandos' },
    { command: 'sobre', description: 'Sobre o BGC Ofertas' }
  ]);

  scheduler.start();
  logger.info('BGC Ofertas iniciado em long polling.');
  if (!scheduler.hasConfiguredSource()) {
    logger.info('Nenhuma fonte automática configurada. O modo manual está ativo.');
  }
  if (!config.autoPublish) {
    logger.info('Publicação automática desativada (OFFER_AUTO_PUBLISH=false).');
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.on('bgc:duplicate-polling', () => shutdown('duplicate-polling'));
}

main().catch((error) => {
  logger.error('Falha na inicialização.', error.message);
  releaseInstanceLock();
  process.exit(1);
});

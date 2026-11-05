import './src/preload.js';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { assertRuntimeConfig, loadConfig, PROJECT_ROOT } from './src/config.js';
import { createBot, stopBot } from './src/bot.js';
import { logger } from './src/logger.js';
import { registerPublicCommands } from './src/commands/public.js';
import { registerMessageHandler } from './src/handlers/message-handler.js';
import { registerCallbackHandler } from './src/handlers/callback-handler.js';
import { registerTemplateCallbacks, registerTemplateCommand } from './src/commands/template.js';
import { registerCategoryCallbacks, registerCategoryCommand } from './src/commands/category.js';
import { OfferService } from './src/services/offer-service.js';
import { PublishingService } from './src/services/publishing-service.js';
import { SchedulerService } from './src/services/scheduler-service.js';
import { TemplateService } from './src/services/template-service.js';
import { CategoryService } from './src/services/category-service.js';
import { JsonStorage } from './src/storage/json-storage.js';
import { createConfiguredSources } from './src/sources/json-feed-source.js';
import { InstanceLock } from './src/process-lock.js';
import { createShopeeAffiliateClient } from './src/services/shopee-affiliate-client.js';
import { evaluateReadiness } from './src/services/readiness-service.js';

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const LOCK_FILE = path.join(PROJECT_ROOT, 'data', 'bot.pid');
const instanceLock = new InstanceLock({
  lockFile: LOCK_FILE,
  pid: process.pid,
  projectRoot: PROJECT_ROOT
});
let bot;
let scheduler;
let shuttingDown = false;

function releaseInstanceLock() {
  instanceLock.release();
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

function registerShutdownHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    try {
      process.on(signal, () => {
        shutdown(signal).catch((error) => {
          logger.warn('Falha no encerramento.', error.message);
          releaseInstanceLock();
          process.exit(1);
        });
      });
    } catch {
      // sinal indisponível nesta plataforma
    }
  }
  process.on('exit', () => {
    releaseInstanceLock();
  });
  process.on('bgc:duplicate-polling', () => {
    shutdown('duplicate-polling').catch(() => {
      releaseInstanceLock();
      process.exit(1);
    });
  });
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
  instanceLock.acquire();

  const storage = new JsonStorage(path.join(config.dataDir, 'offers.json'));
  await storage.init();

  const offerService = new OfferService(storage);
  const templateService = new TemplateService(storage);
  const categoryService = new CategoryService(storage, config);
  bot = createBot(config.token, { polling: true });
  const publishingService = new PublishingService({ bot, config, offerService, templateService });
  const shopeeClient = createShopeeAffiliateClient(config);
  const sources = createConfiguredSources(config, { shopeeClient });
  scheduler = new SchedulerService({
    config,
    sources,
    offerService,
    publishingService
  });

  const linkOptions = { shopeeClient };
  const ctx = { config, offerService, publishingService, scheduler, templateService, categoryService, linkOptions };

  registerPublicCommands(bot);
  registerMessageHandler(bot, ctx);
  registerCallbackHandler(bot, ctx);
  registerTemplateCommand(bot, ctx);
  registerTemplateCallbacks(bot, ctx);
  registerCategoryCommand(bot, ctx);
  registerCategoryCallbacks(bot, ctx);

  const categorySettings = await categoryService.get();
  scheduler.applyCategorySettings(categorySettings);

  await bot.setMyCommands([
    { command: 'start', description: 'Apresentação do BGC Ofertas' },
    { command: 'ajuda', description: 'Lista de comandos' },
    { command: 'sobre', description: 'Sobre o BGC Ofertas' },
    { command: 'modelo', description: 'Modelo de publicação (equipe)' },
    { command: 'categoria', description: 'Categorias da automação (equipe)' }
  ]);

  scheduler.start();
  logger.info('BGC Ofertas iniciado em long polling.');
  if (!scheduler.hasConfiguredSource()) {
    logger.info('Nenhuma fonte automática configurada. O modo manual está ativo.');
  }
  if (!config.autoPublish) {
    logger.info('Publicação automática desativada (OFFER_AUTO_PUBLISH=false).');
  }
  const readiness = evaluateReadiness(config);
  if (!readiness.ok) {
    logger.warn(`Verificação de prontidão: ${readiness.blockers.join(' ')}`);
  }

  registerShutdownHandlers();
}

main().catch((error) => {
  logger.error('Falha na inicialização.', error.message);
  releaseInstanceLock();
  process.exit(1);
});

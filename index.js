import './src/preload.js';
import path from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import { assertRuntimeConfig, loadConfig, PROJECT_ROOT } from './src/config.js';
import { createBot, startBotPolling, stopBot } from './src/bot.js';
import { logger } from './src/logger.js';
import { registerPublicCommands } from './src/commands/public.js';
import { registerMessageHandler } from './src/handlers/message-handler.js';
import { registerCallbackHandler } from './src/handlers/callback-handler.js';
import { registerTemplateCallbacks, registerTemplateCommand } from './src/commands/template.js';
import { registerSettingsCallbacks, registerSettingsCommand } from './src/commands/settings.js';
import { registerCategoryCallbacks, registerCategoryCommand } from './src/commands/category.js';
import { registerBotMenuCommands } from './src/commands/bot-commands.js';
import { OfferService } from './src/services/offer-service.js';
import { PublishingService } from './src/services/publishing-service.js';
import { SchedulerService } from './src/services/scheduler-service.js';
import { TemplateService } from './src/services/template-service.js';
import { SettingsService } from './src/services/settings-service.js';
import { CategoryService } from './src/services/category-service.js';
import { CouponService } from './src/services/coupon-service.js';
import { JsonStorage } from './src/storage/json-storage.js';
import { createConfiguredSources } from './src/sources/json-feed-source.js';
import { InstanceLock } from './src/process-lock.js';
import { createShopeeAffiliateClient } from './src/services/shopee-affiliate-client.js';
import { evaluateReadiness } from './src/services/readiness-service.js';
import { PriceHistoryStore } from './src/deal-engine/price-store.js';
import { PuxadorInboxStore } from './src/puxador/inbox-store.js';
import { registerPuxadorChannelPostHandler } from './src/puxador/channel-post-handler.js';

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
  const priceStore = PriceHistoryStore.fromConfig(config);
  await priceStore.init();
  const puxadorInboxStore = new PuxadorInboxStore(path.join(config.dataDir, 'puxador-inbox.json'));
  await puxadorInboxStore.init();

  const settingsService = new SettingsService(storage, config);
  const categoryService = new CategoryService(storage, {
    excludeBooks: config.excludeBooks,
    shopeeKeywords: config.shopeeKeywords
  });
  const couponService = new CouponService(storage);
  const offerService = new OfferService(storage, { settingsService, couponService });
  const templateService = new TemplateService(storage);
  bot = createBot(config.token);
  registerPuxadorChannelPostHandler(bot, {
    allowedChatIds: config.puxadorSourceChatIds,
    inboxStore: puxadorInboxStore,
    logger
  });
  const publishingService = new PublishingService({
    bot,
    config,
    offerService,
    templateService,
    couponService,
    settingsService,
    priceStore,
    dealEngine: config.dealEngine
  });
  const shopeeClient = createShopeeAffiliateClient(config);
  const sources = createConfiguredSources(config, { shopeeClient });
  scheduler = new SchedulerService({
    config,
    sources,
    offerService,
    publishingService,
    settingsService,
    couponService,
    priceStore,
    dealEngine: config.dealEngine
  });

  const linkOptions = { shopeeClient };
  const ctx = {
    config,
    offerService,
    publishingService,
    scheduler,
    templateService,
    settingsService,
    categoryService,
    couponService,
    linkOptions,
    puxadorInboxStore
  };

  registerPublicCommands(bot);
  registerMessageHandler(bot, ctx);
  registerCallbackHandler(bot, ctx);
  registerTemplateCommand(bot, ctx);
  registerTemplateCallbacks(bot, ctx);
  registerSettingsCommand(bot, ctx);
  registerSettingsCallbacks(bot, ctx);
  registerCategoryCommand(bot, ctx);
  registerCategoryCallbacks(bot, ctx);

  await registerBotMenuCommands(bot, config);

  if (scheduler.applyCategorySettings) {
    const categorySettings = await settingsService.categorySettings?.() ?? settingsService.all?.() ?? {};
    scheduler.applyCategorySettings?.(categorySettings);
  }
  if (scheduler.applyScheduleSettings) {
    const scheduleSettings = await settingsService.scheduleSettings?.() ?? {};
    scheduler.applyScheduleSettings?.(scheduleSettings);
  }

  registerShutdownHandlers();
  await startBotPolling(bot);

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
}

main().catch((error) => {
  logger.error('Falha na inicialização.', error.message);
  releaseInstanceLock();
  process.exit(1);
});

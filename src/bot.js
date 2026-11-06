import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger.js';
import { isDuplicatePollingError } from './polling-error.js';

export { isDuplicatePollingError };

export function createBot(token, options = {}) {
  const bot = new TelegramBot(token, {
    polling: false,
    filepath: false,
    ...options.telegram
  });

  bot.on('polling_error', (error) => {
    if (isDuplicatePollingError(error)) {
      logger.warn('Outra instância do bot já está em polling. Encerrando esta para evitar duplicidade.');
      process.emit('bgc:duplicate-polling');
      return;
    }
    logger.warn('Erro de polling.', error.message);
  });

  bot.on('error', (error) => {
    logger.warn('Erro do cliente Telegram.', error.message);
  });

  return bot;
}

export async function startBotPolling(bot) {
  if (!bot) return false;
  if (bot._bgcPollingStarted) return false;
  if (bot.isPolling?.()) return false;
  if (typeof bot.deleteWebHook === 'function') {
    await bot.deleteWebHook().catch((error) => {
      logger.warn('Falha ao remover webhook antes do polling.', error.message);
    });
  }
  if (typeof bot.startPolling === 'function') {
    bot._bgcPollingStarted = true;
    await bot.startPolling();
  }
  return true;
}

export async function stopBot(bot) {
  if (!bot) return;
  try {
    if (typeof bot.stopPolling === 'function') {
      await bot.stopPolling({ cancel: true });
    }
    if (typeof bot.close === 'function') {
      await bot.close();
    }
  } catch (error) {
    logger.warn('Falha ao encerrar o bot com graça.', error.message);
  }
}

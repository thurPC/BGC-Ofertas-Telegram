import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger.js';

export function createBot(token, options = {}) {
  const bot = new TelegramBot(token, {
    polling: options.polling !== false,
    filepath: false,
    ...options.telegram
  });

  bot.on('polling_error', (error) => {
    const code = error?.code || error?.response?.statusCode;
    if (code === 409) {
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

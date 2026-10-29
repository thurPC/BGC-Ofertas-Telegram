import { logger } from '../logger.js';
import { chooseSendMode, formatOfferHtml } from '../formatters/offer-message.js';
import { OFFER_STATUS } from './offer-service.js';
import { validateHttpUrl } from './validation-service.js';

function isTelegramError(error) {
  return Boolean(error?.response?.body || error?.code === 'ETELEGRAM');
}

function publicError(error) {
  if (isTelegramError(error)) {
    const description = error.response?.body?.description || error.message;
    if (/bot was blocked/i.test(description)) return 'O bot foi bloqueado neste chat.';
    if (/chat not found/i.test(description)) return 'Canal ou chat não encontrado. Confira TELEGRAM_CHANNEL_ID.';
    if (/not enough rights|need administrator/i.test(description)) {
      return 'O bot precisa ser administrador do canal com permissão para publicar.';
    }
    if (/wrong file identifier|failed to get http url content|WEBPAGE_CURL_FAILED|wrong type of the web page content/i.test(description)) {
      return 'A imagem não pôde ser enviada. A oferta será publicada apenas com texto.';
    }
    if (/message is too long/i.test(description)) return 'A mensagem ultrapassou o limite do Telegram.';
    return 'Falha ao publicar no Telegram. Verifique permissões do bot no canal.';
  }
  return 'Falha ao publicar a oferta.';
}

export class PublishingService {
  constructor({ bot, config, offerService }) {
    this.bot = bot;
    this.config = config;
    this.offerService = offerService;
  }

  canPublish(offer) {
    if (!offer) return { ok: false, error: 'Oferta não encontrada.' };
    if (!offer.url) return { ok: false, error: 'Não é possível publicar sem um link válido.' };
    const url = validateHttpUrl(offer.url, { required: true });
    if (!url.ok) return { ok: false, error: url.error };
    if (![OFFER_STATUS.READY, OFFER_STATUS.DRAFT].includes(offer.status) && offer.status !== OFFER_STATUS.PUBLISHED) {
      if (offer.status === OFFER_STATUS.EXPIRED) return { ok: false, error: 'A oferta está expirada.' };
      if (offer.status === OFFER_STATUS.CANCELLED) return { ok: false, error: 'A oferta foi cancelada.' };
    }
    if (!offer.name || offer.price == null || !offer.store) {
      return { ok: false, error: 'A oferta ainda não está completa para publicação.' };
    }
    return { ok: true };
  }

  async sendToChat(chatId, offer) {
    const html = formatOfferHtml(offer);
    const mode = chooseSendMode(offer, html);
    const extra = {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };

    if (mode.method === 'sendPhoto') {
      try {
        const message = await this.bot.sendPhoto(chatId, mode.photo, {
          caption: mode.text,
          ...extra
        });
        return { ok: true, message, method: 'sendPhoto' };
      } catch (error) {
        logger.warn('Falha ao enviar foto, tentando texto.', error.message);
        const fallback = await this.bot.sendMessage(chatId, html, extra);
        return { ok: true, message: fallback, method: 'sendMessage', imageFailed: true };
      }
    }

    const message = await this.bot.sendMessage(chatId, mode.text, extra);
    return { ok: true, message, method: 'sendMessage', truncated: Boolean(mode.truncated) };
  }

  async publish(offer, { actorId, targetChatId } = {}) {
    const check = this.canPublish(offer);
    if (!check.ok) return check;

    const chatId = targetChatId || this.config.channelId;
    if (!chatId) return { ok: false, error: 'Canal de publicação não configurado.' };

    try {
      const result = await this.sendToChat(chatId, offer);
      if (offer.id && this.offerService) {
        await this.offerService.markPublished(offer.id, { actorId });
      }
      return { ...result, publishedTo: chatId };
    } catch (error) {
      logger.error('Erro ao publicar oferta.', error.message);
      return { ok: false, error: publicError(error) };
    }
  }

  async preview(chatId, offer) {
    try {
      return await this.sendToChat(chatId, offer);
    } catch (error) {
      logger.warn('Falha na prévia.', error.message);
      return { ok: false, error: publicError(error) };
    }
  }
}

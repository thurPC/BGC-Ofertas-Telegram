import { logger } from '../logger.js';
import { chooseSendMode, formatOfferHtml } from '../formatters/offer-message.js';
import { analyzeExclusion, exclusionMessage } from './exclusion-filter.js';
import { categoryMismatchMessage, offerMatchesCategories } from './category-service.js';
import { duplicateMessage, findDuplicates, fingerprint, identityKeys, OFFER_STATUS } from './offer-service.js';
import { defaultTemplate, mergeTemplate } from './template-service.js';
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
  constructor({ bot, config, offerService, templateService, couponService, settingsService }) {
    this.bot = bot;
    this.config = config;
    this.offerService = offerService;
    this.templateService = templateService;
    this.couponService = couponService;
    this.settingsService = settingsService;
    this.inFlight = new Set();
  }

  async attachCoupon(offer, actorId) {
    if (!this.couponService?.associate) return offer;
    try {
      const associated = await this.couponService.associate(offer, {
        persist: Boolean(offer?.id),
        actorId
      });
      return associated?.offer || offer;
    } catch {
      return offer;
    }
  }

  async resolveTemplate() {
    if (this.templateService?.get) return this.templateService.get();
    return mergeTemplate({
      ...defaultTemplate(),
      channelLink: this.config?.channelLink || defaultTemplate().channelLink
    });
  }

  async exclusionOptions() {
    if (this.offerService?.exclusionOptions) {
      return this.offerService.exclusionOptions();
    }
    return {};
  }

  async categorySettings() {
    if (this.settingsService?.categorySettings) {
      return this.settingsService.categorySettings();
    }
    if (this.offerService?.settingsService?.categorySettings) {
      return this.offerService.settingsService.categorySettings();
    }
    return null;
  }

  async canPublish(offer) {
    if (!offer) return { ok: false, error: 'Oferta não encontrada.' };
    const exclusion = analyzeExclusion(offer, await this.exclusionOptions());
    if (exclusion.excluded) {
      return { ok: false, error: exclusionMessage(exclusion.reasons) };
    }
    const categorySettings = await this.categorySettings();
    const sourceName = String(offer.source ?? 'manual');
    if (
      categorySettings &&
      sourceName !== 'manual' &&
      !offerMatchesCategories(offer, categorySettings)
    ) {
      return { ok: false, error: categoryMismatchMessage(offer, categorySettings) };
    }
    if (!offer.url) return { ok: false, error: 'Não é possível publicar sem um link válido.' };
    const url = validateHttpUrl(offer.url, { required: true });
    if (!url.ok) return { ok: false, error: url.error };
    if (offer.status === OFFER_STATUS.PUBLISHED) {
      return { ok: false, error: duplicateMessage([{ ...offer, status: OFFER_STATUS.PUBLISHED }]), duplicate: true };
    }
    if (![OFFER_STATUS.READY, OFFER_STATUS.DRAFT].includes(offer.status)) {
      if (offer.status === OFFER_STATUS.EXPIRED) return { ok: false, error: 'A oferta está expirada.' };
      if (offer.status === OFFER_STATUS.CANCELLED) return { ok: false, error: 'A oferta foi cancelada.' };
      return { ok: false, error: 'A oferta não está pronta para publicação.' };
    }
    if (!offer.name || offer.price == null) {
      return { ok: false, error: 'A oferta ainda não está completa para publicação.' };
    }
    return { ok: true };
  }

  async assertNotDuplicate(offer) {
    if (!this.offerService?.list) return { ok: true };
    const existing = await this.offerService.list();
    const duplicates = findDuplicates(existing, offer, { excludeId: offer?.id });
    const published = duplicates.filter((item) => item.status === OFFER_STATUS.PUBLISHED);
    if (published.length) {
      return { ok: false, duplicate: true, duplicates: published, error: duplicateMessage(published) };
    }
    if (offer?.status === OFFER_STATUS.PUBLISHED) {
      return { ok: false, duplicate: true, duplicates: [offer], error: duplicateMessage([offer]) };
    }
    return { ok: true };
  }

  async sendToChat(chatId, offer) {
    const template = await this.resolveTemplate();
    const channelLink = template.channelLink || this.config?.channelLink || '';
    const html = formatOfferHtml(offer, { template, channelLink });
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
    const check = await this.canPublish(offer);
    if (!check.ok) return check;

    const uniqueness = await this.assertNotDuplicate(offer);
    if (!uniqueness.ok) return uniqueness;

    const chatId = targetChatId || this.config.channelId;
    if (!chatId) return { ok: false, error: 'Canal de publicação não configurado.' };

    const lockKeys = [`fp:${fingerprint(offer)}`];
    if (offer.id) lockKeys.push(`id:${offer.id}`);
    for (const key of identityKeys(offer)) lockKeys.push(`ik:${key}`);
    if (lockKeys.some((key) => this.inFlight.has(key))) {
      return { ok: false, duplicate: true, error: duplicateMessage([{ ...offer, status: OFFER_STATUS.PUBLISHED }]) };
    }
    for (const key of lockKeys) this.inFlight.add(key);

    const prepared = await this.attachCoupon(offer, actorId);
    const needsImageReview = !prepared.imageUrl;
    try {
      const result = await this.sendToChat(chatId, prepared);
      if (offer.id && this.offerService) {
        await this.offerService.markPublished(offer.id, { actorId });
      }
      return { ...result, publishedTo: chatId, needsImageReview };
    } catch (error) {
      logger.error('Erro ao publicar oferta.', error.message);
      return { ok: false, error: publicError(error) };
    } finally {
      for (const key of lockKeys) this.inFlight.delete(key);
    }
  }

  async preview(chatId, offer) {
    try {
      const prepared = await this.attachCoupon(offer);
      const result = await this.sendToChat(chatId, prepared);
      return { ...result, needsImageReview: !prepared.imageUrl };
    } catch (error) {
      logger.warn('Falha na prévia.', error.message);
      return { ok: false, error: publicError(error) };
    }
  }
}

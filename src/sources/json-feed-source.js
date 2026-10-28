import { OfferSource, normalizeFetchedOffer } from './source-interface.js';
import { logger } from '../logger.js';
import { calculateDiscount } from '../services/validation-service.js';

export class JsonFeedSource extends OfferSource {
  constructor(feedUrl) {
    super('json-feed');
    this.feedUrl = String(feedUrl ?? '').trim();
  }

  isConfigured() {
    return /^https?:\/\//i.test(this.feedUrl);
  }

  describe() {
    return {
      name: this.name,
      configured: this.isConfigured(),
      note: this.isConfigured()
        ? 'Feed JSON autorizado configurado. A publicação automática permanece desativada até o administrador habilitar.'
        : 'Nenhuma fonte automática configurada. O modo manual continua disponível.'
    };
  }

  async fetchOffers() {
    if (!this.isConfigured()) return [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(this.feedUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        logger.warn(`Feed JSON retornou HTTP ${response.status}.`);
        return [];
      }
      const payload = await response.json();
      const items = Array.isArray(payload) ? payload : payload?.offers || payload?.items || [];
      return items.map((item) => {
        const offer = normalizeFetchedOffer(item, item.store || 'Feed');
        offer.discountPercent = calculateDiscount(offer.previousPrice, offer.price);
        return offer;
      });
    } catch (error) {
      logger.warn('Falha ao consultar feed JSON autorizado.', error.message);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createConfiguredSources(config) {
  const sources = [];
  if (config.feedUrl) sources.push(new JsonFeedSource(config.feedUrl));
  return sources;
}

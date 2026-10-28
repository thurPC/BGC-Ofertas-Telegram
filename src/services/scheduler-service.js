import { logger } from '../logger.js';
import { applyOfferFilters, isWithinAllowedHours } from '../sources/source-interface.js';
import { findDuplicates } from './offer-service.js';
import { validateOfferInput } from './validation-service.js';

export class SchedulerService {
  constructor({ config, sources, offerService, publishingService, onTick }) {
    this.config = config;
    this.sources = sources || [];
    this.offerService = offerService;
    this.publishingService = publishingService;
    this.onTick = onTick;
    this.timer = null;
    this.running = false;
  }

  hasConfiguredSource() {
    return this.sources.some((source) => source.isConfigured());
  }

  describe() {
    if (!this.sources.length) {
      return {
        enabled: false,
        sources: [],
        note: 'Nenhuma fonte automática configurada. O cadastro manual funciona normalmente.'
      };
    }
    return {
      enabled: Boolean(this.config.autoPublish),
      sources: this.sources.map((source) => source.describe()),
      note: this.config.autoPublish
        ? 'Publicação automática habilitada por configuração, mas só executa com fonte válida e confirmação operacional.'
        : 'Publicação automática desativada por padrão.'
    };
  }

  start() {
    if (this.timer) return;
    const ms = this.config.checkIntervalMinutes * 60 * 1000;
    this.timer = setInterval(() => {
      this.run().catch((error) => logger.warn('Falha no agendador.', error.message));
    }, ms);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info(`Agendador iniciado. Intervalo: ${this.config.checkIntervalMinutes} minuto(s).`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async run() {
    if (this.running) return { skipped: true, reason: 'already-running' };
    this.running = true;
    try {
      if (typeof this.onTick === 'function') this.onTick();
      if (!this.hasConfiguredSource()) {
        return {
          ok: true,
          fetched: 0,
          published: 0,
          note: 'Busca automática depende de integração real. Nenhuma fonte está configurada.'
        };
      }
      if (!this.config.autoPublish) {
        return {
          ok: true,
          fetched: 0,
          published: 0,
          note: 'Publicação automática desativada. Configure uma fonte válida e habilite OFFER_AUTO_PUBLISH.'
        };
      }
      if (!isWithinAllowedHours(new Date(), this.config.allowedHours)) {
        return { ok: true, fetched: 0, published: 0, note: 'Fora do horário permitido.' };
      }

      const existing = await this.offerService.list();
      const collected = [];
      for (const source of this.sources) {
        if (!source.isConfigured()) continue;
        const items = await source.fetchOffers();
        collected.push(...items);
      }

      const filtered = applyOfferFilters(collected, this.config).slice(0, this.config.maxOffersPerRun);
      let published = 0;
      const errors = [];

      for (const item of filtered) {
        const validation = validateOfferInput(item);
        if (!validation.ok) {
          errors.push({ name: item.name, errors: validation.errors });
          continue;
        }
        const duplicates = findDuplicates(existing, validation.offer);
        if (duplicates.length) continue;
        const created = await this.offerService.create(
          { ...validation.offer, source: item.source || 'auto' },
          { actorId: 'scheduler' }
        );
        if (!created.ok) continue;
        existing.push(created.offer);
        const result = await this.publishingService.publish(created.offer, { actorId: 'scheduler' });
        if (result.ok) published += 1;
        else errors.push({ name: created.offer.name, errors: [result.error] });
      }

      return { ok: true, fetched: collected.length, published, errors };
    } finally {
      this.running = false;
    }
  }
}

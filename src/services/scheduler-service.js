import { logger } from '../logger.js';
import { applyOfferFilters, isWithinAllowedHours } from '../sources/source-interface.js';
import { analyzeExclusion, isExcludedProduct } from './exclusion-filter.js';
import { findDuplicates } from './offer-service.js';
import { validateOfferInput } from './validation-service.js';

export class SchedulerService {
  constructor({ config, sources, offerService, publishingService, settingsService, couponService, onTick }) {
    this.config = config;
    this.sources = sources || [];
    this.offerService = offerService;
    this.publishingService = publishingService;
    this.settingsService = settingsService;
    this.couponService = couponService;
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
        ? 'Publicação automática habilitada por configuração, mas só executa no horário definido e com fonte válida.'
        : 'Publicação automática desativada por padrão. O feed pode ser lido e importado como oferta pronta, sem publicar no canal.'
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

  async collectFromSources() {
    const collected = [];
    const sourceErrors = [];
    const coupons = [];
    for (const source of this.sources) {
      if (!source.isConfigured()) continue;
      const result = typeof source.fetch === 'function'
        ? await source.fetch()
        : { ok: true, offers: await source.fetchOffers(), errors: [], reason: null };
      if (!result.ok) {
        sourceErrors.push({
          source: source.name,
          reason: result.reason,
          errors: result.errors
        });
        continue;
      }
      collected.push(...(result.offers || []));
      if (Array.isArray(result.coupons)) coupons.push(...result.coupons);
    }
    return { collected, sourceErrors, coupons };
  }

  async importFromSources({ publish = false } = {}) {
    if (!this.hasConfiguredSource()) {
      return {
        ok: true,
        fetched: 0,
        imported: 0,
        published: 0,
        duplicates: 0,
        errors: [],
        note: 'Busca automática depende de integração real. Nenhuma fonte está configurada.'
      };
    }

    const existing = await this.offerService.list();
    const { collected, sourceErrors, coupons } = await this.collectFromSources();
    if (this.couponService && coupons?.length) {
      try {
        await this.couponService.upsertMany(coupons, { actorId: 'scheduler', source: 'json-feed' });
        await this.couponService.expireStale({ actorId: 'scheduler' });
      } catch (error) {
        logger.warn('Falha ao atualizar cupons. As ofertas seguem normalmente.', error.message);
      }
    }
    const runtimeConfig = this.settingsService
      ? await this.settingsService.runtimeConfig()
      : this.config;
    const blockedItems = collected.filter((item) => isExcludedProduct(item, runtimeConfig));
    let contentBlocked = blockedItems.length;
    if (contentBlocked > 0) {
      logger.info(`Filtro de conteúdo: ${contentBlocked} item(ns) de livro/publicação descartado(s) na seleção.`, {
        names: blockedItems.map((item) => item.name).slice(0, 20)
      });
    }
    const filtered = applyOfferFilters(collected, runtimeConfig).slice(0, this.config.maxOffersPerRun);
    const errors = [...sourceErrors];
    let imported = 0;
    let published = 0;
    let duplicates = 0;

    for (const item of filtered) {
      const validation = validateOfferInput(item);
      if (!validation.ok) {
        errors.push({ name: item.name, errors: validation.errors });
        continue;
      }
      // Defesa em profundidade: nada que seja livro/publicação passa daqui.
      const exclusion = analyzeExclusion(validation.offer, runtimeConfig);
      if (exclusion.excluded) {
        contentBlocked += 1;
        continue;
      }
      const candidate = {
        ...validation.offer,
        url: item.url || validation.offer.url,
        imageUrl: item.imageUrl || validation.offer.imageUrl,
        externalId: item.externalId || null
      };
      if (findDuplicates(existing, candidate).length) {
        duplicates += 1;
        continue;
      }
      const created = await this.offerService.create(
        { ...candidate, source: item.source || 'json-feed', externalId: candidate.externalId },
        { actorId: 'scheduler' }
      );
      if (!created.ok) {
        errors.push({ name: item.name, errors: created.errors || [created.error] });
        continue;
      }
      existing.push(created.offer);
      imported += 1;
      if (publish) {
        const result = await this.publishingService.publish(created.offer, { actorId: 'scheduler' });
        if (result.ok) published += 1;
        else errors.push({ name: created.offer.name, errors: [result.error] });
      }
    }

    return {
      ok: true,
      fetched: collected.length,
      imported,
      published,
      duplicates,
      contentBlocked,
      errors
    };
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
          imported: 0,
          published: 0,
          note: 'Busca automática depende de integração real. Nenhuma fonte está configurada.'
        };
      }
      if (!this.config.autoPublish) {
        const { collected, sourceErrors, coupons } = await this.collectFromSources();
        if (this.couponService && coupons?.length) {
          try {
            await this.couponService.upsertMany(coupons, { actorId: 'scheduler', source: 'json-feed' });
            await this.couponService.expireStale({ actorId: 'scheduler' });
          } catch (error) {
            logger.warn('Falha ao atualizar cupons. As ofertas seguem normalmente.', error.message);
          }
        }
        return {
          ok: true,
          fetched: collected.length,
          imported: 0,
          published: 0,
          errors: sourceErrors,
          note: 'Publicação automática desativada. O feed foi consultado apenas para leitura. Nada foi importado nem publicado no canal. Use importação administrativa ou OFFER_AUTO_PUBLISH=true após revisão.'
        };
      }
      const allowedHours = this.settingsService
        ? await this.settingsService.allowedHours()
        : this.config.allowedHours;
      if (!isWithinAllowedHours(new Date(), allowedHours)) {
        return { ok: true, fetched: 0, imported: 0, published: 0, note: 'Fora do horário permitido.' };
      }
      return this.importFromSources({ publish: true });
    } finally {
      this.running = false;
    }
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';
import { applyOfferFilters, isWithinAllowedHours } from '../sources/source-interface.js';
import { analyzeExclusion, isExcludedProduct } from './exclusion-filter.js';
import { findDuplicates } from './offer-service.js';
import { identityMatchesPublished, offerIdentityKeys } from './offer-identity.js';
import { validateOfferInput } from './validation-service.js';
import { detectCategory, rankOffers } from './offer-scorer.js';
import { evaluateReadiness } from './readiness-service.js';
import { enabledCategories, mergeCategorySettings } from './category-service.js';
import { hoursFromSchedule, mergeScheduleSettings } from './schedule-service.js';
import { formatOfferHtml } from '../formatters/offer-message.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function duplicateKeys(offers) {
  const keys = new Set();
  for (const offer of offers) {
    for (const key of offerIdentityKeys(offer)) keys.add(key);
  }
  return keys;
}

function hasPublishedIdentity(candidate, publishedKeys) {
  return identityMatchesPublished(candidate, publishedKeys);
}

export class SchedulerService {
  constructor({ config, sources, offerService, publishingService, settingsService, couponService, onTick, sleepFn, lockFile }) {
    this.config = config;
    this.sources = sources || [];
    this.offerService = offerService;
    this.publishingService = publishingService;
    this.settingsService = settingsService;
    this.couponService = couponService;
    this.onTick = onTick;
    this.sleepFn = sleepFn || sleep;
    this.timer = null;
    this.running = false;
    this.lockFile = lockFile || (config?.dataDir ? path.join(config.dataDir, 'scheduler.lock') : null);
  }

  applyCategorySettings(settings) {
    const resolved = mergeCategorySettings(settings);
    this.config.excludeBooks = resolved.excludeBooks !== false;
    this.config.enabledCategories = resolved.enabled;
    const categories = enabledCategories(resolved);
    const allowed = new Set(resolved.enabled);
    const envKeywords = (this.config.shopeeKeywords || []).filter((keyword) => {
      const category = detectCategory({ name: keyword });
      return !category || allowed.has(category);
    });
    const keywords = [...categories.map((item) => item.keywords[0]), ...envKeywords, ...resolved.extraKeywords];
    for (const source of this.sources) {
      if (typeof source.applySearchOptions === 'function') {
        source.applySearchOptions({ categories, keywords });
      }
    }
    return resolved;
  }

  applyScheduleSettings(settings) {
    const resolved = mergeScheduleSettings(settings);
    this.config.allowedHours = hoursFromSchedule(resolved);
    this.config.schedule = resolved;
    return resolved;
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
    const readiness = evaluateReadiness(this.config);
    return {
      enabled: Boolean(this.config.autoPublish),
      sources: this.sources.map((source) => source.describe()),
      note: this.config.autoPublish
        ? readiness.ok
          ? 'Publicação automática habilitada. Só ofertas validadas, com link afiliado e sem duplicata, entram no canal.'
          : `Publicação automática bloqueada: ${readiness.blockers.join(' ')}`
        : 'Modo teste: o agendador consulta, pontua e registra ofertas, mas não publica no canal (OFFER_AUTO_PUBLISH=false).'
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

  async #acquireRunLock() {
    if (!this.lockFile) return true;
    try {
      await fs.mkdir(path.dirname(this.lockFile), { recursive: true });
      const handle = await fs.open(this.lockFile, 'wx');
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        'utf8'
      );
      await handle.close();
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const raw = await fs.readFile(this.lockFile, 'utf8');
        const payload = JSON.parse(raw);
        const ageMs = Date.now() - new Date(payload.at).getTime();
        const staleAfter = Math.max(Number(this.config?.checkIntervalMinutes) || 30, 5) * 60 * 1000;
        if (!Number.isFinite(ageMs) || ageMs > staleAfter) {
          await fs.unlink(this.lockFile).catch(() => undefined);
          return this.#acquireRunLock();
        }
      } catch {
        await fs.unlink(this.lockFile).catch(() => undefined);
        return this.#acquireRunLock();
      }
      return false;
    }
  }

  async #releaseRunLock() {
    if (!this.lockFile) return;
    await fs.unlink(this.lockFile).catch(() => undefined);
  }

  #selectCandidates(collected, existing, publishedKeys) {
    const excludedBooks = (collected || []).filter((item) => isExcludedProduct(item, this.config)).length;
    const filtered = applyOfferFilters(collected, this.config);
    const unique = [];
    const seen = new Set();
    let duplicates = 0;
    const knownKeys = publishedKeys instanceof Set ? new Set(publishedKeys) : duplicateKeys(existing);
    const enabled = Array.isArray(this.config.enabledCategories) ? this.config.enabledCategories : [];
    for (const item of filtered) {
      if (isExcludedProduct(item, this.config)) continue;
      if (enabled.length) {
        const category = item.category || detectCategory(item);
        if (category && !enabled.includes(category)) continue;
      }
      const validation = validateOfferInput(item);
      if (!validation.ok) continue;
      const candidate = {
        ...item,
        ...validation.offer,
        url: item.url || validation.offer.url,
        imageUrl: item.imageUrl || validation.offer.imageUrl,
        externalId: item.externalId || null,
        productLink: item.productLink || null,
        itemId: item.itemId || null,
        shopId: item.shopId || null,
        source: item.source || 'json-feed',
        commissionRate: item.commissionRate,
        sales: item.sales,
        ratingStar: item.ratingStar,
        category: item.category,
        description: item.description,
        priceDiscountRate: item.priceDiscountRate
      };
      const identity = offerIdentityKeys(candidate);
      if (identity.some((key) => seen.has(key)) || hasPublishedIdentity(candidate, knownKeys)) {
        duplicates += 1;
        continue;
      }
      if (findDuplicates(existing, candidate).length) {
        duplicates += 1;
        continue;
      }
      for (const key of identity) seen.add(key);
      unique.push(candidate);
    }

    const ranked = rankOffers(unique, {
      publishedKeys: knownKeys,
      limit: this.config.maxOffersPerRun,
      minScore: this.config.minOfferScore,
      requireAffiliateLink: this.config.requireAffiliateLink === true,
      excludeBooks: this.config.excludeBooks,
      bookExcludeKeywords: this.config.bookExcludeKeywords,
      bookDeviceAllowKeywords: this.config.bookDeviceAllowKeywords
    });
    return {
      ...ranked,
      duplicates,
      excludedBooks,
      invalid: filtered.length - unique.length - duplicates
    };
  }

  async importFromSources({ publish = false, collected, sourceErrors, existing, selection } = {}) {
    if (!this.hasConfiguredSource()) {
      return {
        ok: true,
        fetched: 0,
        imported: 0,
        published: 0,
        duplicates: 0,
        excludedBooks: 0,
        errors: [],
        note: 'Busca automática depende de integração real. Nenhuma fonte está configurada.'
      };
    }

    const current = existing || await this.offerService.list();
    const publishedKeys =
      typeof this.offerService.seenKeys === 'function'
        ? await this.offerService.seenKeys()
        : duplicateKeys(current);
    const batch = collected
      ? { collected, sourceErrors: sourceErrors || [], coupons: null }
      : await this.collectFromSources();
    const runtimeConfig = this.settingsService
      ? await this.settingsService.runtimeConfig()
      : this.config;
    const chosen = selection || this.#selectCandidates(batch.collected, current, publishedKeys);
    let contentBlocked = 0;
    const blockedItems = batch.collected.filter((item) => isExcludedProduct(item, runtimeConfig));
    contentBlocked = blockedItems.length;
    if (contentBlocked > 0) {
      logger.info(`Filtro de conteúdo: ${contentBlocked} item(ns) de livro/publicação descartado(s) na seleção.`, {
        names: blockedItems.map((item) => item.name).slice(0, 20)
      });
    }
    if (this.couponService && batch.coupons?.length) {
      try {
        await this.couponService.upsertMany(batch.coupons, { actorId: 'scheduler', source: 'json-feed' });
        await this.couponService.expireStale({ actorId: 'scheduler' });
      } catch (error) {
        logger.warn('Falha ao atualizar cupons. As ofertas seguem normalmente.', error.message);
      }
    }
    const errors = [...(batch.sourceErrors || [])];
    let imported = 0;
    let published = 0;
    let duplicates = 0;
    const prepared = [];
    const gapMs = (this.config.publishGapSeconds ?? 20) * 1000;
    const seenKeys = [];

    for (const item of chosen.selected) {
      const validation = validateOfferInput(item);
      if (!validation.ok) {
        errors.push({ name: item.name, errors: validation.errors });
        continue;
      }
      const exclusion = analyzeExclusion(validation.offer, runtimeConfig);
      if (exclusion.excluded) {
        contentBlocked += 1;
        continue;
      }
      if (findDuplicates(current, item).length) {
        duplicates += 1;
        continue;
      }
      const created = await this.offerService.create(
        {
          ...item,
          source: item.source || 'json-feed',
          externalId: item.externalId,
          productLink: item.productLink,
          itemId: item.itemId,
          shopId: item.shopId
        },
        { actorId: 'scheduler' }
      );
      if (!created.ok) {
        if (created.duplicate) {
          duplicates += 1;
          continue;
        }
        errors.push({ name: item.name, errors: created.errors || [created.error] });
        continue;
      }
      current.push(created.offer);
      imported += 1;
      prepared.push(created.offer);
      seenKeys.push(...offerIdentityKeys(created.offer));
      if (publish) {
        const result = await this.publishingService.publish(created.offer, { actorId: 'scheduler' });
        if (result.ok) published += 1;
        else errors.push({ name: created.offer.name, errors: [result.error] });
        if (gapMs > 0 && imported < chosen.selected.length) {
          await this.sleepFn(gapMs);
        }
      }
    }

    if (typeof this.offerService.recordAutomationRun === 'function') {
      await this.offerService.recordAutomationRun({
        fetched: batch.collected.length,
        imported,
        published,
        selected: chosen.selected.length,
        duplicates: chosen.duplicates + duplicates,
        rejected: chosen.rejected.length,
        excludedBooks: chosen.excludedBooks ?? 0,
        seenKeys
      });
    }

    return {
      ok: true,
      fetched: batch.collected.length,
      imported,
      published,
      duplicates: chosen.duplicates + duplicates,
      contentBlocked,
      prepared: prepared.length,
      selected: chosen.selected.length,
      excludedBooks: chosen.excludedBooks ?? 0,
      rejected: chosen.rejected.length,
      errors
    };
  }

  async run() {
    if (this.running) return { skipped: true, reason: 'already-running' };
    this.running = true;
    const locked = await this.#acquireRunLock();
    if (!locked) {
      this.running = false;
      return { skipped: true, reason: 'lock-held' };
    }
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

      const { collected, sourceErrors, coupons } = await this.collectFromSources();
      const existing = await this.offerService.list();
      const publishedKeys =
        typeof this.offerService.seenKeys === 'function'
          ? await this.offerService.seenKeys()
          : duplicateKeys(existing);
      const selection = this.#selectCandidates(collected, existing, publishedKeys);
      const messages = [];
      if (this.publishingService?.resolveTemplate) {
        const template = await this.publishingService.resolveTemplate();
        for (const offer of selection.selected) {
          messages.push(formatOfferHtml(offer, { template, channelLink: template.channelLink }));
        }
      }

      if (!this.config.autoPublish) {
        if (this.couponService && coupons?.length) {
          try {
            await this.couponService.upsertMany(coupons, { actorId: 'scheduler', source: 'json-feed' });
            await this.couponService.expireStale({ actorId: 'scheduler' });
          } catch (error) {
            logger.warn('Falha ao atualizar cupons. As ofertas seguem normalmente.', error.message);
          }
        }
        logger.info(
          `Modo teste: ${collected.length} oferta(s) lida(s), ${selection.selected.length} selecionada(s), nenhuma publicação.`
        );
        if (typeof this.offerService.recordAutomationRun === 'function') {
          await this.offerService.recordAutomationRun({
            fetched: collected.length,
            imported: 0,
            published: 0,
            selected: selection.selected.length,
            duplicates: selection.duplicates,
            rejected: selection.rejected.length,
            excludedBooks: selection.excludedBooks ?? 0,
            note: 'dry-run'
          });
        }
        return {
          ok: true,
          fetched: collected.length,
          imported: 0,
          published: 0,
          prepared: selection.selected.length,
          selected: selection.selected.length,
          duplicates: selection.duplicates,
          excludedBooks: selection.excludedBooks ?? 0,
          rejected: selection.rejected.length,
          errors: sourceErrors,
          messages,
          note: 'Publicação automática desativada. O feed foi consultado, pontuado e validado apenas para leitura. Nada foi importado nem publicado no canal. Use importação administrativa ou OFFER_AUTO_PUBLISH=true após revisão.'
        };
      }
      const allowedHours = this.settingsService
        ? (await this.settingsService.allowedHours?.()) ?? this.config.allowedHours
        : this.config.allowedHours;
      if (!isWithinAllowedHours(new Date(), allowedHours)) {
        return { ok: true, fetched: collected.length, imported: 0, published: 0, note: 'Fora do horário permitido.' };
      }

      const readiness = evaluateReadiness(this.config);
      if (!readiness.ok) {
        return {
          ok: false,
          fetched: collected.length,
          imported: 0,
          published: 0,
          errors: readiness.blockers,
          note: 'Publicação automática bloqueada pela verificação de prontidão.'
        };
      }
      return this.importFromSources({
        publish: true,
        collected,
        sourceErrors,
        existing,
        selection
      });
    } finally {
      await this.#releaseRunLock();
      this.running = false;
    }
  }
}

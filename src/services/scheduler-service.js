import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';
import { applyOfferFilters, isWithinAllowedHours } from '../sources/source-interface.js';
import { findDuplicates } from './offer-service.js';
import { validateOfferInput } from './validation-service.js';
import { rankOffers } from './offer-scorer.js';
import { evaluateReadiness } from './readiness-service.js';
import { formatOfferHtml } from '../formatters/offer-message.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function duplicateKeys(offers) {
  const keys = new Set();
  for (const offer of offers) {
    if (offer.externalId) keys.add(String(offer.externalId));
    const url = String(offer.url ?? '').trim().toLowerCase();
    if (url) keys.add(url);
  }
  return keys;
}

export class SchedulerService {
  constructor({ config, sources, offerService, publishingService, onTick, sleepFn, lockFile }) {
    this.config = config;
    this.sources = sources || [];
    this.offerService = offerService;
    this.publishingService = publishingService;
    this.onTick = onTick;
    this.sleepFn = sleepFn || sleep;
    this.timer = null;
    this.running = false;
    this.lockFile = lockFile || (config?.dataDir ? path.join(config.dataDir, 'scheduler.lock') : null);
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
    }
    return { collected, sourceErrors };
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

  #selectCandidates(collected, existing) {
    const filtered = applyOfferFilters(collected, this.config);
    const unique = [];
    const seen = new Set();
    let duplicates = 0;
    for (const item of filtered) {
      const validation = validateOfferInput(item);
      if (!validation.ok) continue;
      const candidate = {
        ...item,
        ...validation.offer,
        url: item.url || validation.offer.url,
        imageUrl: item.imageUrl || validation.offer.imageUrl,
        externalId: item.externalId || null,
        source: item.source || 'json-feed',
        commissionRate: item.commissionRate,
        sales: item.sales,
        ratingStar: item.ratingStar,
        category: item.category,
        priceDiscountRate: item.priceDiscountRate
      };
      const key = candidate.externalId || String(candidate.url || '').toLowerCase();
      if (key && seen.has(key)) {
        duplicates += 1;
        continue;
      }
      if (findDuplicates(existing, candidate).length) {
        duplicates += 1;
        continue;
      }
      if (key) seen.add(key);
      unique.push(candidate);
    }

    const ranked = rankOffers(unique, {
      publishedKeys: duplicateKeys(existing),
      limit: this.config.maxOffersPerRun,
      minScore: this.config.minOfferScore,
          requireAffiliateLink: this.config.requireAffiliateLink === true
    });
    return { ...ranked, duplicates, invalid: filtered.length - unique.length - duplicates };
  }

  async importFromSources({ publish = false, collected, sourceErrors, existing, selection } = {}) {
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

    const current = existing || await this.offerService.list();
    const batch = collected
      ? { collected, sourceErrors: sourceErrors || [] }
      : await this.collectFromSources();
    const chosen = selection || this.#selectCandidates(batch.collected, current);
    const errors = [...(batch.sourceErrors || [])];
    let imported = 0;
    let published = 0;
    const prepared = [];
    const gapMs = (this.config.publishGapSeconds ?? 20) * 1000;
    const seenKeys = [];

    for (const item of chosen.selected) {
      const created = await this.offerService.create(
        { ...item, source: item.source || 'json-feed', externalId: item.externalId },
        { actorId: 'scheduler' }
      );
      if (!created.ok) {
        errors.push({ name: item.name, errors: created.errors || [created.error] });
        continue;
      }
      current.push(created.offer);
      imported += 1;
      prepared.push(created.offer);
      if (created.offer.externalId) seenKeys.push(created.offer.externalId);
      if (created.offer.url) seenKeys.push(String(created.offer.url).toLowerCase());
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
        duplicates: chosen.duplicates,
        rejected: chosen.rejected.length,
        seenKeys
      });
    }

    return {
      ok: true,
      fetched: batch.collected.length,
      imported,
      published,
      prepared: prepared.length,
      selected: chosen.selected.length,
      duplicates: chosen.duplicates,
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

      const { collected, sourceErrors } = await this.collectFromSources();
      const existing = await this.offerService.list();
      const selection = this.#selectCandidates(collected, existing);
      const messages = [];
      if (this.publishingService?.resolveTemplate) {
        const template = await this.publishingService.resolveTemplate();
        for (const offer of selection.selected) {
          messages.push(formatOfferHtml(offer, { template, channelLink: template.channelLink }));
        }
      }

      if (!this.config.autoPublish) {
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
          rejected: selection.rejected.length,
          errors: sourceErrors,
          messages,
          note: 'Publicação automática desativada. O feed foi consultado, pontuado e validado apenas para leitura. Nada foi importado nem publicado no canal. Use importação administrativa ou OFFER_AUTO_PUBLISH=true após revisão.'
        };
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

      if (!isWithinAllowedHours(new Date(), this.config.allowedHours)) {
        return { ok: true, fetched: collected.length, imported: 0, published: 0, note: 'Fora do horário permitido.' };
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

import { mergeDealEngineConfig, QUEUE_STATUS } from './defaults.js';
import { adaptDiscoveredProduct } from './discovery.js';
import { identifyProduct } from './identity.js';
import { applySemanticAuxiliary } from './semantic.js';
import { classifyProduct } from './classification.js';
import { compareMarkets, netSavings } from './comparison.js';
import { scoreConfidence } from './confidence.js';
import { applyDiversity, evaluateDedup, variantKey } from './dedup.js';
import { createCycleTracker, statusFromGate } from './diagnostics.js';
import { CyclePriceCache, isFreshSnapshot } from './cache.js';
import { effectivePrice } from './price-intelligence.js';
import { evaluateQualityGate } from './quality-gate.js';
import { buildQueueItem, persistQueue, revalidateItem } from './queue.js';
import { validateAffiliateLink } from './affiliate.js';
import { scoreDeal } from './scoring.js';
import { formatOfferHtml } from '../formatters/offer-message.js';

export function evaluateOffer(rawOffer, context = {}) {
  const config = mergeDealEngineConfig(context.config);
  const offer = adaptDiscoveredProduct(rawOffer, rawOffer?.source || context.sourceName || 'unknown');
  let identity = context.identity || identifyProduct(offer);
  if (context.semanticPeers) {
    identity = applySemanticAuxiliary(identity, offer, context.semanticPeers);
  }
  const classification = context.classification || classifyProduct(offer, identity);
  offer.affiliate = validateAffiliateLink(offer, { requireAffiliateLink: context.requireAffiliateLink });
  const stats = context.stats || {
    sampleSize: 0,
    median30: null,
    min: null,
    insufficient: true
  };
  const evaluated = {
    offer,
    identity,
    classification,
    stats,
    finalPrice: effectivePrice(offer)
  };
  evaluated.comparison = context.comparison || compareMarkets(evaluated, context.catalog || []);
  evaluated.savings = netSavings(offer, evaluated.comparison, stats);
  evaluated.deal = scoreDeal(evaluated, { weights: config.weights });
  evaluated.confidence = scoreConfidence(evaluated, { sourceReliability: config.sourceReliability });
  const dedup = evaluateDedup(evaluated, {
    config,
    publishedKeys: context.publishedKeys,
    publications: context.publications,
    cycleIdentityKeys: context.cycleIdentityKeys,
    cycleTitleKeys: context.cycleTitleKeys,
    now: context.now
  });
  evaluated.duplicate = dedup.duplicate;
  evaluated.duplicateReason = dedup.reason;
  evaluated.variantKey = dedup.variantKey || variantKey(identity);
  evaluated.gate = evaluateQualityGate(evaluated, {
    config,
    requireAffiliateLink: context.requireAffiliateLink
  });
  evaluated.status = statusFromGate(evaluated.gate, identity);
  if (evaluated.status === QUEUE_STATUS.QUARANTINE) evaluated.quarantine = true;
  evaluated.queueItem = buildQueueItem(evaluated, {
    status: evaluated.status,
    rejection: evaluated.gate.ok ? null : evaluated.gate.messages
  });
  return evaluated;
}

export async function runDealEngine(offers, context = {}) {
  const config = mergeDealEngineConfig(context.config);
  const tracker = context.tracker || createCycleTracker();
  const now = context.now || new Date();
  const catalog = [];
  const evaluated = [];
  const cycleIdentityKeys = new Set();
  const cycleTitleKeys = new Set();

  tracker.markStart('discovery');
  const incoming = Array.isArray(offers) ? offers : [];
  tracker.count('discovered', incoming.length);
  tracker.markEnd('discovery');

  tracker.markStart('identify');
  const cache = context.priceCache || new CyclePriceCache();
  for (const raw of incoming) {
    const offer = adaptDiscoveredProduct(raw, raw?.source || 'unknown');
    const identity = identifyProduct(offer);
    const classification = classifyProduct(offer, identity);
    if (identity.key && !identity.uncertain) tracker.count('identified');
    if (classification.eligible) tracker.count('classified');
    catalog.push({ offer, identity, classification, finalPrice: effectivePrice(offer) });
  }
  tracker.markEnd('identify');

  tracker.markStart('history');
  const withStats = [];
  for (const item of catalog) {
    let stats = {
      sampleSize: 0,
      median30: null,
      min: null,
      insufficient: true
    };
    if (context.priceStore && item.identity?.key) {
      try {
        if (isFreshSnapshot(item.offer, 30 * 60 * 1000, now.getTime())) {
          await context.priceStore.record(item.offer, item.identity, { snapshotLimit: config.snapshotLimit });
        }
        const cached = cache.get(item.identity.key, now.getTime());
        stats = cached || (await context.priceStore.stats(item.identity.key, now));
        cache.set(item.identity.key, stats, now.getTime());
      } catch {
        stats = { sampleSize: 0, median30: null, min: null, insufficient: true };
      }
    } else if (context.statsByKey && item.identity?.key) {
      stats = context.statsByKey[item.identity.key] || stats;
    }
    withStats.push({ ...item, stats });
  }
  if (context.priceStore?.prune) {
    await context.priceStore.prune(config.historyRetentionDays, now).catch(() => undefined);
  }
  tracker.markEnd('history');

  tracker.markStart('score');
  for (const item of withStats) {
    const result = evaluateOffer(item.offer, {
      config,
      identity: item.identity,
      classification: item.classification,
      stats: item.stats,
      catalog: withStats,
      publishedKeys: context.publishedKeys,
      publications: context.publications,
      cycleIdentityKeys,
      cycleTitleKeys,
      requireAffiliateLink: context.requireAffiliateLink,
      now
    });
    if (result.identity?.key) cycleIdentityKeys.add(result.identity.key);
    if (result.offer?.name) cycleTitleKeys.add(String(result.offer.name).toLowerCase());
    if (!result.gate.ok) {
      for (const reason of result.gate.reasons) tracker.reject(reason);
      if (result.quarantine) tracker.count('quarantined');
    } else {
      tracker.count('ranked');
    }
    evaluated.push(result);
  }
  tracker.markEnd('score');

  const approved = evaluated
    .filter((item) => item.gate.ok)
    .sort((a, b) => (b.deal?.dealScore || 0) - (a.deal?.dealScore || 0));
  const diverse = applyDiversity(approved, config);
  const selected = (diverse.length ? diverse : approved).slice(
    0,
    Number.isInteger(context.limit) && context.limit > 0 ? context.limit : undefined
  );
  const queued = selected.map((item) => ({
    ...item.queueItem,
    status: QUEUE_STATUS.QUEUED
  }));
  tracker.count('queued', queued.length);
  if (context.priceStore) {
    await persistQueue(context.priceStore, queued);
  }

  const report = tracker.finish();
  if (typeof context.priceStore?.saveCycleReport === 'function') {
    await context.priceStore.saveCycleReport(report);
  }

  return {
    evaluated,
    approved: selected,
    rejected: evaluated.filter((item) => !item.gate.ok),
    queued,
    report,
    durationMs: report.durationMs
  };
}

export function dryRunOffer(evaluated, options = {}) {
  const gate = evaluated.gate || { ok: false, messages: ['sem avaliação'] };
  const message = options.template
    ? formatOfferHtml(evaluated.offer, { template: options.template, channelLink: options.channelLink })
    : null;
  return {
    product: evaluated.identity?.model || evaluated.offer?.name || null,
    brand: evaluated.identity?.brand || null,
    category: evaluated.classification?.label || null,
    variant: evaluated.identity?.variant || {},
    history: evaluated.stats || null,
    comparison: evaluated.comparison || null,
    dealScore: evaluated.deal?.dealScore ?? 0,
    confidenceScore: evaluated.confidence?.confidenceScore ?? 0,
    approved: gate.ok,
    reasons: gate.ok ? evaluated.deal?.reasons || [] : gate.messages,
    message,
    insufficientHistory: Boolean(evaluated.stats?.insufficient)
  };
}

export function revalidateBeforePublish(item, currentOffer) {
  return revalidateItem(item, currentOffer);
}

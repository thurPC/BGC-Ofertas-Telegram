import { clamp, round } from './text.js';

function part(score, weight, evidence, reason) {
  return { score: clamp(score, 0, 100), weight, evidence, reason };
}

export function scoreConfidence(evaluated = {}, options = {}) {
  const identity = evaluated.identity || {};
  const classification = evaluated.classification || {};
  const stats = evaluated.stats || {};
  const offer = evaluated.offer || {};
  const sourceReliability = options.sourceReliability || {};
  const source = offer.source || 'unknown';

  const parts = {
    identity: part(
      identity.confidence ?? 0,
      22,
      Boolean(identity.key) && !identity.uncertain,
      identity.uncertain ? 'identidade incerta' : `identidade por ${identity.method || 'desconhecido'}`
    ),
    category: part(
      classification.confidence ?? 0,
      12,
      Boolean(classification.taxonomyId) && classification.eligible,
      classification.unknown ? 'categoria desconhecida' : `categoria ${classification.label || classification.taxonomyId}`
    ),
    identifiers: part(
      identity.gtin ? 100 : identity.mpn ? 85 : identity.brand && identity.model ? 55 : 15,
      12,
      Boolean(identity.gtin || identity.mpn),
      identity.gtin ? 'GTIN presente' : identity.mpn ? 'MPN presente' : 'sem identificador universal'
    ),
    history: part(
      stats.sampleSize >= 12 ? 100 : stats.sampleSize >= 6 ? 70 : stats.sampleSize >= 3 ? 45 : 10,
      12,
      stats.sampleSize >= 3,
      stats.sampleSize >= 3 ? `${stats.sampleSize} pontos de histórico` : 'histórico insuficiente'
    ),
    freshness: part(
      offer.fetchedAt && Date.now() - new Date(offer.fetchedAt).getTime() < 30 * 60 * 1000 ? 90 : 50,
      8,
      Boolean(offer.fetchedAt),
      'atualidade da consulta'
    ),
    source: part(sourceReliability[source] ?? 50, 10, Boolean(sourceReliability[source]), `fonte ${source}`),
    stock: part(
      offer.stock === true || offer.stock === 'in_stock' || Number(offer.stock) > 0 ? 100 : offer.stock == null ? 40 : 0,
      8,
      offer.stock === true || offer.stock === 'in_stock' || Number(offer.stock) > 0,
      offer.stock == null ? 'estoque não confirmado' : 'estoque avaliado'
    ),
    url: part(/^https:\/\//i.test(String(offer.url || '')) ? 100 : 0, 8, /^https:\/\//i.test(String(offer.url || '')), 'url'),
    variant: part(
      identity.variant && Object.keys(identity.variant).length ? 90 : identity.model ? 55 : 20,
      8,
      Boolean(identity.variant && Object.keys(identity.variant).length),
      identity.variant && Object.keys(identity.variant).length ? 'variante extraída' : 'variante incompleta'
    )
  };

  let total = 0;
  const reasons = [];
  for (const item of Object.values(parts)) {
    total += (item.score * item.weight) / 100;
    reasons.push(item.reason);
  }

  return {
    confidenceScore: clamp(round(total), 0, 100),
    parts,
    reasons
  };
}

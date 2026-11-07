import { DEAL_SCORE_WEIGHTS } from './defaults.js';
import {
  detectArtificialOriginal,
  effectivePrice,
  historicalDiscount,
  listedDiscountPercent,
  proximityToMin
} from './price-intelligence.js';
import { clamp, round } from './text.js';

function weighted(score, weight) {
  return round((clamp(score, 0, 100) * weight) / 100);
}

function historicalComponent(price, stats, offer) {
  if (!stats || stats.insufficient || stats.median30 == null) {
    return { score: 0, evidence: false, reasons: ['histórico insuficiente para desconto real'] };
  }
  const discount = historicalDiscount(price, stats);
  const artificial = detectArtificialOriginal(offer, stats);
  if (artificial.artificial) {
    return { score: 8, evidence: true, reasons: ['preço original aparentemente inflado'] };
  }
  if (discount == null) return { score: 0, evidence: false, reasons: ['sem mediana histórica'] };
  if (discount <= 0) {
    return { score: Math.max(0, 20 + discount), evidence: true, reasons: ['preço na média ou acima da mediana de 30 dias'] };
  }
  const score = clamp(discount * 2.2, 0, 100);
  return {
    score,
    evidence: true,
    reasons: [`preço ${round(discount)}% abaixo da mediana de 30 dias`]
  };
}

function minComponent(price, stats) {
  if (!stats || stats.min == null || stats.sampleSize < 3) {
    return { score: 0, evidence: false, reasons: ['mínima histórica insuficiente'] };
  }
  const proximity = proximityToMin(price, stats);
  if (proximity == null) return { score: 0, evidence: false, reasons: [] };
  const reasons = [];
  if (price <= stats.min) reasons.push('menor preço observado no histórico');
  else reasons.push(`próximo da mínima histórica (${round(proximity)}/100)`);
  return { score: proximity, evidence: true, reasons };
}

function comparisonComponent(comparison) {
  if (!comparison || comparison.comparableCount < 1) {
    return { score: 0, evidence: false, reasons: ['sem pares comparáveis em outras lojas'] };
  }
  if (comparison.isCheapest) {
    return { score: 100, evidence: true, reasons: ['mais barato que as alternativas verificadas'] };
  }
  const score = clamp(comparison.percentile ?? 0, 0, 90);
  return {
    score,
    evidence: true,
    reasons: [`comparado com ${comparison.comparableCount} oferta(s) do mesmo modelo`]
  };
}

function sellerComponent(offer) {
  const rating = Number(offer.ratingStar);
  const sales = Number(offer.sales);
  let score = 0;
  let evidence = false;
  const reasons = [];
  if (Number.isFinite(rating)) {
    evidence = true;
    score += clamp((rating - 3.5) * 40, 0, 70);
    if (rating >= 4.5) reasons.push('vendedor com boa reputação');
  }
  if (Number.isFinite(sales)) {
    evidence = true;
    score += sales >= 500 ? 30 : sales >= 100 ? 18 : 8;
  }
  if (!evidence) return { score: 0, evidence: false, reasons: ['sem dados de vendedor'] };
  return { score: clamp(score, 0, 100), evidence: true, reasons };
}

function popularityComponent(offer) {
  const sales = Number(offer.sales);
  if (!Number.isFinite(sales)) return { score: 0, evidence: false, reasons: ['sem dados de demanda'] };
  const score = sales >= 1000 ? 100 : sales >= 200 ? 70 : sales >= 50 ? 40 : 15;
  return { score, evidence: true, reasons: ['demanda observada nas vendas'] };
}

function savingsComponent(offer, comparison, stats) {
  const freight = Number(offer.freight ?? offer.shipping ?? 0) || 0;
  const coupon = Number(offer.couponDiscountAmount) || 0;
  let score = 40;
  const reasons = [];
  if (coupon > 0) {
    score += 25;
    reasons.push('cupom aplicável considerado no preço final');
  }
  if (freight === 0) {
    score += 20;
    reasons.push('frete não encarece a oferta');
  } else {
    score -= Math.min(20, freight > 40 ? 20 : 10);
  }
  if (comparison?.isCheapest) score += 15;
  if (stats?.median30 && offer.price && offer.price < stats.median30) score += 10;
  return { score: clamp(score, 0, 100), evidence: true, reasons };
}

function freshnessComponent(offer) {
  const stock = offer.stock ?? offer.stockStatus;
  const fetchedAt = offer.fetchedAt ? new Date(offer.fetchedAt).getTime() : Date.now();
  const ageMin = (Date.now() - fetchedAt) / 60000;
  let score = ageMin <= 30 ? 80 : ageMin <= 180 ? 55 : 25;
  const reasons = [];
  if (stock === true || stock === 'in_stock' || Number(stock) > 0) {
    score += 20;
    reasons.push('estoque confirmado');
  } else if (stock === false || stock === 'out_of_stock' || stock === 0) {
    return { score: 0, evidence: true, reasons: ['sem estoque'] };
  } else {
    reasons.push('atualidade da consulta considerada; estoque não confirmado');
  }
  return { score: clamp(score, 0, 100), evidence: true, reasons };
}

export function scoreDeal(evaluated, options = {}) {
  const weights = { ...DEAL_SCORE_WEIGHTS, ...(options.weights || {}) };
  const offer = evaluated.offer || evaluated;
  const stats = evaluated.stats || options.stats || null;
  const comparison = evaluated.comparison || options.comparison || null;
  const price = evaluated.finalPrice ?? effectivePrice(offer);
  const advertised = listedDiscountPercent(offer);

  const parts = {
    historicalDiscount: historicalComponent(price, stats, offer),
    nearHistoricalMin: minComponent(price, stats),
    storeComparison: comparisonComponent(comparison),
    sellerTrust: sellerComponent(offer),
    popularity: popularityComponent(offer),
    netSavings: savingsComponent(offer, comparison, stats),
    freshness: freshnessComponent(offer)
  };

  let total = 0;
  const reasons = [];
  const breakdown = {};
  for (const [key, weight] of Object.entries(weights)) {
    const part = parts[key] || { score: 0, evidence: false, reasons: [] };
    const points = part.evidence ? weighted(part.score, weight) : 0;
    breakdown[key] = { weight, score: part.score, points, evidence: part.evidence };
    total += points;
    reasons.push(...part.reasons);
  }

  if (advertised != null && (!stats || stats.insufficient)) {
    reasons.push('desconto anunciado pela loja não foi usado como desconto real');
  }

  const dealScore = clamp(round(total), 0, 100);
  return {
    dealScore,
    breakdown,
    reasons,
    advertisedDiscount: advertised,
    finalPrice: price
  };
}

export function formatDealScore(result) {
  const lines = [`Deal Score: ${result.dealScore}/100`, '', 'Motivos:'];
  for (const reason of result.reasons || []) {
    lines.push(`- ${reason}`);
  }
  return lines.join('\n');
}

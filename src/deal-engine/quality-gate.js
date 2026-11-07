import { mergeDealEngineConfig } from './defaults.js';
import { validateHttpUrl } from '../services/validation-service.js';
import { asPositiveNumber } from './text.js';
import { validateAffiliateLink } from './affiliate.js';

export const GATE_REASONS = {
  UNIDENTIFIED: 'unidentified-product',
  UNCERTAIN_IDENTITY: 'uncertain-identity',
  UNKNOWN_CATEGORY: 'unknown-category',
  INELIGIBLE_CATEGORY: 'ineligible-category',
  VARIANT_UNCONFIRMED: 'variant-unconfirmed',
  INVALID_PRICE: 'invalid-price',
  OUT_OF_STOCK: 'out-of-stock',
  SELLER_UNACCEPTABLE: 'seller-unacceptable',
  INVALID_LINK: 'invalid-link',
  STALE_PRICE: 'stale-price',
  DUPLICATE: 'duplicate',
  LOW_DEAL_SCORE: 'low-deal-score',
  LOW_CONFIDENCE: 'low-confidence',
  MISSING_AFFILIATE: 'missing-affiliate-link'
};

export function evaluateQualityGate(evaluated, options = {}) {
  const config = mergeDealEngineConfig(options.config);
  const offer = evaluated.offer || {};
  const identity = evaluated.identity || {};
  const classification = evaluated.classification || {};
  const failures = [];

  if (!identity.key || identity.method === 'uncertain') {
    failures.push({ code: GATE_REASONS.UNIDENTIFIED, message: 'Produto não identificado com confiança.' });
  } else if (identity.uncertain) {
    failures.push({ code: GATE_REASONS.UNCERTAIN_IDENTITY, message: 'Identidade incerta; oferta em quarentena.' });
  }

  if (!classification.eligible || classification.unknown) {
    failures.push({
      code: classification.family === 'ineligible' ? GATE_REASONS.INELIGIBLE_CATEGORY : GATE_REASONS.UNKNOWN_CATEGORY,
      message: classification.reason === 'ineligible-publication'
        ? 'Publicações e livros não são elegíveis.'
        : 'Categoria desconhecida; produto não será publicado.'
    });
  }

  if (identity.model && (!identity.variant || !Object.keys(identity.variant).length) && classification.taxonomyId) {
    const needsVariant = ['gpus', 'processors', 'ssds', 'ram', 'refrigerators', 'washers', 'air-conditioners'].includes(
      classification.taxonomyId
    );
    if (needsVariant) {
      failures.push({ code: GATE_REASONS.VARIANT_UNCONFIRMED, message: 'Variante relevante não confirmada.' });
    }
  }

  const price = asPositiveNumber(offer.price);
  if (price == null || price <= 0) {
    failures.push({ code: GATE_REASONS.INVALID_PRICE, message: 'Preço inválido ou ausente.' });
  }

  const stock = offer.stock ?? offer.stockStatus;
  if (stock === false || stock === 'out_of_stock' || stock === 0) {
    failures.push({ code: GATE_REASONS.OUT_OF_STOCK, message: 'Estoque não confirmado ou esgotado.' });
  }

  if (offer.sellerBanned || offer.sellerRating === 'bad') {
    failures.push({ code: GATE_REASONS.SELLER_UNACCEPTABLE, message: 'Vendedor abaixo do critério aceitável.' });
  }

  const url = validateHttpUrl(offer.url, { required: true });
  if (!url.ok) {
    failures.push({ code: GATE_REASONS.INVALID_LINK, message: url.error || 'Link inválido.' });
  }

  if (offer.fetchedAt) {
    const ageMs = Date.now() - new Date(offer.fetchedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > 6 * 60 * 60 * 1000) {
      failures.push({ code: GATE_REASONS.STALE_PRICE, message: 'Preço desatualizado.' });
    }
  }

  if (evaluated.duplicate) {
    failures.push({ code: GATE_REASONS.DUPLICATE, message: evaluated.duplicateReason || 'Oferta duplicada.' });
  }

  const dealScore = evaluated.deal?.dealScore ?? evaluated.dealScore ?? 0;
  const confidence = evaluated.confidence?.confidenceScore ?? evaluated.confidenceScore ?? 0;
  if (dealScore < config.minDealScore) {
    failures.push({
      code: GATE_REASONS.LOW_DEAL_SCORE,
      message: `Deal Score ${dealScore} abaixo do mínimo ${config.minDealScore}.`
    });
  }
  if (confidence < config.minConfidence) {
    failures.push({
      code: GATE_REASONS.LOW_CONFIDENCE,
      message: `Confidence Score ${confidence} abaixo do mínimo ${config.minConfidence}.`
    });
  }

  const affiliate = offer.affiliate || validateAffiliateLink(offer, options);
  if (!affiliate.ok && affiliate.reason === 'missing-affiliate') {
    failures.push({ code: GATE_REASONS.MISSING_AFFILIATE, message: affiliate.error });
  }

  return {
    ok: failures.length === 0,
    failures,
    reasons: failures.map((item) => item.code),
    messages: failures.map((item) => item.message)
  };
}

import { isBookOffer } from '../services/book-filter.js';
import { detectCategory } from '../services/offer-scorer.js';
import {
  familyOf,
  isBoardGame,
  isIneligiblePublication,
  LEGACY_CATEGORY_MAP,
  legacyIdsForTaxonomy,
  offerHaystack,
  PRODUCT_FAMILIES,
  TAXONOMY,
  taxonomyById
} from './taxonomy.js';
import { includesPhrase, normalizeText } from './text.js';

function scoreEntry(entry, offer, haystack) {
  let score = 0;
  const evidence = [];
  const storeCategory = normalizeText(offer?.storeCategory || offer?.category || '');
  for (const item of entry.storeCategories || []) {
    if (storeCategory && (storeCategory === normalizeText(item) || storeCategory.includes(normalizeText(item)))) {
      score += 40;
      evidence.push('store-category');
      break;
    }
  }
  for (const term of entry.terms || []) {
    if (includesPhrase(haystack, term) || haystack.includes(normalizeText(term))) {
      score += 18;
      evidence.push(`term:${term}`);
    }
  }
  if (offer?.taxonomyId === entry.id) {
    score += 50;
    evidence.push('explicit');
  }
  return { score, evidence };
}

export function classifyProduct(offer = {}, identity = null) {
  if (isBookOffer(offer) || isIneligiblePublication(offer)) {
    return {
      taxonomyId: null,
      family: PRODUCT_FAMILIES.INELIGIBLE,
      label: 'Publicação',
      confidence: 95,
      reason: 'ineligible-publication',
      unknown: false,
      eligible: false,
      legacyIds: []
    };
  }

  if (isBoardGame(offer)) {
    return {
      taxonomyId: null,
      family: PRODUCT_FAMILIES.UNKNOWN,
      label: 'Jogo de tabuleiro',
      confidence: 70,
      reason: 'board-game',
      unknown: true,
      eligible: false,
      legacyIds: []
    };
  }

  const haystack = offerHaystack({
    ...offer,
    model: identity?.model,
    brand: identity?.brand
  });
  let best = null;
  for (const entry of TAXONOMY) {
    const scored = scoreEntry(entry, offer, haystack);
    if (!best || scored.score > best.score) {
      best = { entry, ...scored };
    }
  }

  const legacy = detectCategory(offer);
  if ((!best || best.score < 18) && legacy) {
    const mapped = LEGACY_CATEGORY_MAP[legacy]?.[0];
    const entry = taxonomyById(mapped);
    if (entry) {
      return {
        taxonomyId: entry.id,
        family: entry.family,
        label: entry.label,
        confidence: 55,
        reason: 'legacy-category',
        unknown: false,
        eligible: true,
        legacyIds: [legacy],
        evidence: ['legacy']
      };
    }
  }

  if (!best || best.score < 18) {
    return {
      taxonomyId: null,
      family: PRODUCT_FAMILIES.UNKNOWN,
      label: 'Desconhecido',
      confidence: 20,
      reason: 'unknown',
      unknown: true,
      eligible: false,
      legacyIds: legacy ? [legacy] : []
    };
  }

  const confidence = Math.min(96, 40 + best.score);
  return {
    taxonomyId: best.entry.id,
    family: best.entry.family,
    label: best.entry.label,
    confidence,
    reason: 'taxonomy',
    unknown: false,
    eligible: true,
    legacyIds: legacyIdsForTaxonomy(best.entry.id),
    evidence: best.evidence
  };
}

export function classificationFamily(classification) {
  return classification?.family || familyOf(classification?.taxonomyId) || PRODUCT_FAMILIES.UNKNOWN;
}

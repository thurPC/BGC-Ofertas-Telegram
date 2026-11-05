import { calculateDiscount } from './validation-service.js';
import { isShopeeAffiliateUrl } from './shopee-affiliate-client.js';
import { isBookOffer } from './book-filter.js';

export const DEFAULT_CATEGORIES = [
  {
    id: 'tecnologia',
    label: 'Tecnologia',
    keywords: ['tecnologia', 'notebook', 'smartphone', 'celular', 'tablet', 'smartwatch', 'iphone', 'samsung galaxy']
  },
  {
    id: 'informatica',
    label: 'Informática e periféricos',
    keywords: ['informática', 'periféricos', 'mouse', 'teclado', 'headset', 'ssd', 'pendrive', 'webcam', 'monitor']
  },
  {
    id: 'games',
    label: 'Games e acessórios',
    keywords: ['games', 'gamer', 'playstation', 'xbox', 'nintendo', 'controle', 'cadeira gamer', 'placa de vídeo']
  },
  {
    id: 'eletronicos',
    label: 'Eletrônicos',
    keywords: ['eletrônicos', 'tv', 'fone bluetooth', 'caixa de som', 'carregador', 'power bank', 'smart tv']
  },
  {
    id: 'casa',
    label: 'Casa e utilidades',
    keywords: ['casa', 'utilidades', 'air fryer', 'aspirador', 'liquidificador', 'ferro de passar', 'cafeteira']
  }
];

const CATEGORY_TERMS = DEFAULT_CATEGORIES.flatMap((category) =>
  category.keywords.map((keyword) => ({ keyword: normalize(keyword), id: category.id }))
);

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function detectCategory(offer) {
  if (offer?.category && DEFAULT_CATEGORIES.some((item) => item.id === offer.category)) {
    return offer.category;
  }
  const haystack = normalize(`${offer?.name ?? ''} ${offer?.store ?? ''}`);
  if (!haystack) return null;
  const match = CATEGORY_TERMS.find((item) => haystack.includes(item.keyword));
  return match?.id ?? null;
}

export function hasEssentialOfferData(offer) {
  return Boolean(
    offer &&
      asName(offer.name) &&
      offer.price != null &&
      Number.isFinite(Number(offer.price)) &&
      Number(offer.price) >= 0 &&
      String(offer.url ?? '').startsWith('https://')
  );
}

function asName(value) {
  const name = String(value ?? '').trim();
  return name.length >= 4 ? name : '';
}

export function isAffiliateTrackingUrl(url, store) {
  const value = String(url ?? '');
  if (!/^https:\/\//i.test(value)) return false;
  const shop = String(store ?? '').toLowerCase();
  if (shop.includes('shopee') || /shopee|shope\.ee|shp\.ee/i.test(value)) {
    return isShopeeAffiliateUrl(value);
  }
  try {
    const parsed = new URL(value);
    return parsed.searchParams.size > 0 || /affiliate|tag=|utm_|matt_|afiliado/i.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

export function scoreOffer(offer, context = {}) {
  const publishedKeys = context.publishedKeys instanceof Set ? context.publishedKeys : new Set(context.publishedKeys || []);
  const reasons = [];

  if (!hasEssentialOfferData(offer)) {
    return { score: 0, reject: 'incomplete', discountPercent: null, category: null, reasons };
  }

  if (isBookOffer(offer, context)) {
    return { score: 0, reject: 'book', discountPercent: null, category: detectCategory(offer), reasons };
  }

  const key = offer.externalId || String(offer.url ?? '').trim().toLowerCase();
  if (key && publishedKeys.has(key)) {
    return { score: 0, reject: 'duplicate', discountPercent: null, category: detectCategory(offer), reasons };
  }

  const requireAffiliate =
    context.requireAffiliateLink === true || String(offer.source || '').includes('shopee');
  if (requireAffiliate && !isAffiliateTrackingUrl(offer.url, offer.store)) {
    return { score: 0, reject: 'no-affiliate-link', discountPercent: null, category: detectCategory(offer), reasons };
  }

  let score = 0;
  score += 10;
  reasons.push('nome');
  score += 10;
  reasons.push('preco');
  if (offer.imageUrl) {
    score += 8;
    reasons.push('imagem');
  }
  if (isAffiliateTrackingUrl(offer.url, offer.store)) {
    score += 12;
    reasons.push('afiliado');
  }

  const discountPercent = calculateDiscount(offer.previousPrice, offer.price);
  if (discountPercent != null && discountPercent >= 15) {
    score += Math.min(30, discountPercent * 0.7);
    reasons.push('desconto-comprovado');
  } else if (discountPercent != null && discountPercent >= 5) {
    score += 6;
    reasons.push('desconto-modesto');
  } else if (offer.priceDiscountRate != null && offer.priceDiscountRate > 0) {
    score += 2;
    reasons.push('desconto-anunciado');
  }

  const price = Number(offer.price);
  if (price > 0 && price <= 150) score += 6;
  else if (price <= 400) score += 3;
  else if (price > 5000) score -= 4;

  if (offer.commissionRate != null && offer.commissionRate > 0) {
    score += Math.min(12, Number(offer.commissionRate));
    reasons.push('comissao');
  }

  if (offer.sales != null && offer.sales >= 100) score += 4;
  if (offer.ratingStar != null && offer.ratingStar >= 4.5) score += 3;

  const category = detectCategory(offer);
  if (category) {
    score += 8;
    reasons.push('categoria');
  }

  const minScore = Number.isFinite(context.minScore) ? context.minScore : 28;
  if (score < minScore) {
    return { score, reject: 'low-score', discountPercent, category, reasons };
  }

  return { score, reject: null, discountPercent, category, reasons };
}

export function rankOffers(offers, context = {}) {
  const ranked = [];
  const rejected = [];
  for (const offer of offers) {
    const scored = scoreOffer(offer, context);
    const item = { ...offer, ...scored, discountPercent: scored.discountPercent ?? offer.discountPercent ?? null };
    if (scored.reject) rejected.push(item);
    else ranked.push(item);
  }
  ranked.sort((a, b) => b.score - a.score);
  const limit = Number.isInteger(context.limit) && context.limit > 0 ? context.limit : ranked.length;
  return { selected: ranked.slice(0, limit), ranked, rejected };
}

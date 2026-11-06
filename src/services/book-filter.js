export const DEFAULT_BOOK_EXCLUDE_KEYWORDS = [
  'livro',
  'livros',
  'livraria',
  'ebook',
  'ebooks',
  'e-book',
  'e-books',
  'e book',
  'audiolivro',
  'audiolivros',
  'audio livro',
  'audiobook',
  'audiobooks',
  'mangá',
  'mangás',
  'manga',
  'mangas',
  'hq',
  'hqs',
  'quadrinho',
  'quadrinhos',
  'historia em quadrinhos',
  'revista',
  'revistas',
  'apostila',
  'apostilas',
  'enciclopedia',
  'enciclopedias',
  'dicionario',
  'dicionarios',
  'kindle unlimited',
  'graphic novel',
  'graphic novels'
];

export const DEFAULT_BOOK_DEVICE_ALLOW_KEYWORDS = [
  'kindle',
  'kindle paperwhite',
  'kindle oasis',
  'kindle scribe',
  'kindle fire',
  'capa kindle',
  'capa para kindle',
  'case kindle',
  'pelicula kindle',
  'suporte kindle',
  'carregador kindle',
  'tablet',
  'tablets',
  'ipad',
  'e-reader',
  'ereader',
  'leitor digital',
  'leitor de ebook',
  'leitor de ebooks',
  'leitor de e-book',
  'leitor de e-books',
  'leitor de e book',
  'leitor de e books',
  'leitor de livros digitais',
  'kobo'
];

const CLOTHING_MANGA_PHRASES = [
  'manga longa',
  'manga curta',
  'manga raglan',
  'sem manga',
  'manga 3 4',
  'manga bufante',
  'manga princesa',
  'comprimento da manga',
  'tipo de manga'
];

const BOOKISH_EBOOK_KEYS = new Set(['ebook', 'ebooks', 'e book', 'e books']);

function uniqueKeywords(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = String(value ?? '').trim();
    if (!key) continue;
    const signature = normalizeText(key);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    result.push(key);
  }
  return result;
}

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasPhrase(text, phrase) {
  const normalizedPhrase = normalizeText(phrase);
  if (!normalizedPhrase || !text) return false;
  const parts = normalizedPhrase.split(/\s+/).map(escapeRegex);
  const pattern = new RegExp(`(?:^|\\s)${parts.join('\\s+')}(?:\\s|$)`);
  return pattern.test(text);
}

function offerText(offer) {
  return [
    offer?.category,
    offer?.categoryName,
    offer?.name,
    offer?.title,
    offer?.description,
    offer?.productDescription,
    offer?.desc
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

function matchingKeywords(normalized, keywords) {
  return keywords.filter((keyword) => hasPhrase(normalized, keyword));
}

function looksLikeClothingManga(raw, normalized) {
  if (CLOTHING_MANGA_PHRASES.some((phrase) => hasPhrase(normalized, phrase))) return true;
  return false;
}

function isPlainMangaKeyword(keyword) {
  return normalizeText(keyword) === 'manga' || normalizeText(keyword) === 'mangas';
}

function keepBookKeyword(keyword, raw, normalized) {
  if (!isPlainMangaKeyword(keyword)) return true;
  if (/mang[áÁ]/i.test(String(raw))) return true;
  return !looksLikeClothingManga(raw, normalized);
}

export function resolveBookFilterConfig(config = {}) {
  const extraExclude = Array.isArray(config.bookExcludeKeywords) ? config.bookExcludeKeywords : [];
  const extraAllow = Array.isArray(config.bookDeviceAllowKeywords) ? config.bookDeviceAllowKeywords : [];
  return {
    enabled: config.excludeBooks !== false,
    excludeKeywords: uniqueKeywords([...DEFAULT_BOOK_EXCLUDE_KEYWORDS, ...extraExclude]),
    deviceAllowKeywords: uniqueKeywords([...DEFAULT_BOOK_DEVICE_ALLOW_KEYWORDS, ...extraAllow])
  };
}

function isAbsorbedByDevice(keyword, matchedDevice, normalized) {
  const key = normalizeText(keyword);
  if (!key) return true;
  if (matchedDevice.some((device) => normalizeText(device).includes(key))) return true;
  if (key === 'livros' && hasPhrase(normalized, 'leitor de livros digitais')) return true;
  if (BOOKISH_EBOOK_KEYS.has(key)) {
    return (
      hasPhrase(normalized, 'leitor de ebook') ||
      hasPhrase(normalized, 'leitor de ebooks') ||
      hasPhrase(normalized, 'leitor de e book') ||
      hasPhrase(normalized, 'leitor de e books')
    );
  }
  return false;
}

export function isBookOffer(offer, config = {}) {
  const resolved = resolveBookFilterConfig(config);
  if (!resolved.enabled) return false;

  const raw = offerText(offer);
  if (!raw) return false;
  const normalized = normalizeText(raw);
  if (!normalized) return false;

  const matchedBook = matchingKeywords(normalized, resolved.excludeKeywords).filter((keyword) =>
    keepBookKeyword(keyword, raw, normalized)
  );
  if (!matchedBook.length) return false;

  const matchedDevice = matchingKeywords(normalized, resolved.deviceAllowKeywords);
  if (matchedDevice.length && matchedBook.every((keyword) => isAbsorbedByDevice(keyword, matchedDevice, normalized))) {
    return false;
  }

  return true;
}

export function filterNonBookOffers(offers, config = {}) {
  return (offers || []).filter((offer) => !isBookOffer(offer, config));
}

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Filtro permanente de conteúdo — bloqueia livros e publicações impressas/
// digitais antes de qualquer pontuação, seleção, importação ou publicação.
//
// Listas centralizadas abaixo. Extensível por configuração:
//   OFFER_EXCLUDE_CATEGORIES, OFFER_EXCLUDE_KEYWORDS (ver src/config.js)
// ---------------------------------------------------------------------------

export const DEFAULT_EXCLUDED_CATEGORIES = [
  'livro',
  'livros',
  'books',
  'book',
  'ebook',
  'e-book',
  'e book',
  'livros digitais',
  'livro digital',
  'livro eletronico',
  'audiolivro',
  'audiobook',
  'audio livro',
  'manga',
  'mangá',
  'quadrinhos',
  'quadrinho',
  'hq',
  'hqs',
  'gibi',
  'gibis',
  'graphic novel',
  'novela grafica',
  'revista',
  'revistas',
  'magazine',
  'magazines',
  'apostila',
  'apostilas',
  'enciclopedia',
  'enciclopédias',
  'dicionario',
  'dicionários',
  'literatura',
  'literatura brasileira',
  'literatura estrangeira',
  'literatura infantil',
  'literatura juvenil',
  'literatura infanto juvenil',
  'romance',
  'romances',
  'ficcao',
  'ficção',
  'fantasia',
  'fantasia epica',
  'distopia',
  'suspense',
  'thriller',
  'biografia',
  'biografias',
  'autobiografia',
  'poesia',
  'poesias',
  'conto',
  'contos',
  'cronica',
  'cronicas',
  'autoajuda',
  'auto ajuda',
  'historia em quadrinhos',
  'historia em quadrinho'
];

export const DEFAULT_EXCLUDED_KEYWORDS = [
  'livro',
  'livros',
  'literatura',
  'ebook',
  'e-book',
  'e book',
  'livro digital',
  'livro eletronico',
  'livro em pdf',
  'audiolivro',
  'audiobook',
  'audio livro',
  'apostila',
  'enciclopedia',
  'dicionario',
  'revista',
  'magazine',
  'gibi',
  'quadrinho',
  'quadrinhos',
  'graphic novel',
  'novela grafica',
  'hq',
  'edicao kindle',
  'versao kindle',
  'formato kindle',
  'best seller',
  'bestseller',
  'capa dura',
  'capa comum',
  'capa flexivel',
  'brochura',
  'livro de bolso',
  'edicao de bolso',
  'box de livros',
  'box com livros',
  'box livro',
  'kit de livros',
  'coletanea',
  'colecao de livros',
  'edicao comentada',
  'edicao especial de aniversario',
  'isbn',
  'editora',
  'obra literaria',
  'obra completa'
];

// Indicadores fortes de que o item é um DISPOSITIVO (hardware) e não um livro:
// leitores digitais, tablets, e-readers, telas e acessórios. O filtro só
// libera um item que contenha termos de livro quando estes indicadores existem.
const DEVICE_INDICATORS = [
  'leitor digital',
  'leitor de ebook',
  'leitor de ebooks',
  'leitor de livros digitais',
  'ereader',
  'e reader',
  'tablet',
  'ipad',
  'dispositivo',
  'aparelho',
  'e ink',
  'tinta eletronica',
  'kobo',
  'nook',
  'geracao',
  'polegadas'
];

function hasStorageSize(text) {
  return /\b\d+\s*gb\b/.test(text);
}

// Contextos em que o termo de dispositivo se refere a um ARQUIVO de e-book
// exibido no aparelho (ex.: "edição Kindle"), nunca ao hardware em si.
const EBOOK_DEVICE_OVERRIDES = [
  'edicao kindle',
  'versao kindle',
  'formato kindle',
  'para kindle',
  'para o kindle',
  'em kindle',
  'no kindle'
];

// Padrões editoriais presentes em páginas de venda de livros, mesmo quando o
// título não traz a palavra "livro". São específicos o bastante para não
// atingir eletrônicos (ex.: "controle de volume", "caixa de som").
const EDITORIAL_PATTERNS = [
  /\(livro\s+\d+/i, // "Harry Potter e a Pedra Filosofal (Livro 1)"
  /\(volume\s*\d+/i, // "Box Harry Potter (Volume 1)"
  /\(\d+\s*volumes?\)/i, // "Box Game of Thrones (7 volumes)"
  /box\b[^)]*\b(?:livros?|colecao|obra|edi[çc]ao|volumes?)/i, // "Box Harry Potter"
  /kit\b[^)]*\b(?:livros?|colecao|obras)/i,
  /livro\s+\d+\s+da\s+cole[cç][aã]o/i,
  /s[eé]rie\s+(?:de\s+)?livros/i,
  /obra\s+(?:completa|completas)/i
];

// Editoras/livrarias conhecidas do mercado brasileiro usadas como reforço
// quando aparecem em título/descrição junto de outro contexto editorial.
const PUBLISHERS = [
  'companhia das letras',
  'editora intrinseca',
  'editora rocco',
  'editora sextante',
  'editora arqueiro',
  'editora globo',
  'globo livros',
  'principis',
  'via leitura',
  'antofagica',
  'autentica',
  'editora darkside',
  'darkside books',
  'novo conceito',
  'editora aleph',
  'editora planeta',
  'editora objetiva',
  'editora saraiva',
  'editora moderna',
  'editora ftc',
  'bv lavradores',
  'editora intrínseca'
];

const MANGA_CONTEXT = [
  'vol',
  'volume',
  'edicao',
  'tankobon',
  'japones',
  'shonen',
  'seinen',
  'colecao',
  'capitulo',
  'issue',
  'numbers',
  'quadrinho',
  'gibi'
];

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[—–]/g, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasWord(text, word) {
  const source = normalizeText(text);
  const pattern = `(^|[^a-z0-9-])${escapeRegExp(normalizeText(word))}([^a-z0-9-]|$)`;
  return new RegExp(pattern).test(source);
}

function hasContextWord(text, word) {
  return new RegExp(`(^|[^a-z0-9-])${escapeRegExp(word)}([^a-z0-9-]|$)`).test(text);
}

function categoryMatches(categoryText, term) {
  return categoryText.includes(normalizeText(term));
}

function isMangaContextual(text) {
  return MANGA_CONTEXT.some((term) => hasContextWord(text, term));
}

function isDeviceHardware(text) {
  const normalized = text ? normalizeText(text) : '';
  if (EBOOK_DEVICE_OVERRIDES.some((term) => normalized.includes(normalizeText(term)))) return false;
  // A marca/modelo sozinho (ex.: apenas "Kindle") pode ser um e-book. Só
  // liberamos quando há um indicador físico claro de hardware.
  return DEVICE_INDICATORS.some((term) => normalized.includes(normalizeText(term)))
    || (hasWord(normalized, 'kindle') && (hasStorageSize(normalized) || normalized.includes('geracao')));
}

export function analyzeExclusion(product, options = {}) {
  const extraCategories = options.extraCategories || options.excludedCategories || [];
  const extraKeywords = options.extraKeywords || options.excludedKeywords || [];
  const categories = [...DEFAULT_EXCLUDED_CATEGORIES, ...extraCategories];
  const keywords = [...DEFAULT_EXCLUDED_KEYWORDS, ...extraKeywords];

  const categoryText = normalizeText(product?.category);
  const titleText = normalizeText(product?.name ?? product?.title);
  const descriptionText = normalizeText(product?.description);
  const text = `${titleText} ${descriptionText}`.trim();
  const reasons = [];

  // Metadados estruturados de livro (JSON-LD Book) ou flag explicita do extrator.
  if (product?.isBook === true || /^book$/i.test(String(product?.['@type'] ?? ''))) {
    reasons.push('metadados: livro (JSON-LD Book)');
  }

  if (categoryText) {
    for (const term of categories) {
      if (categoryMatches(categoryText, term)) {
        reasons.push(`categoria: ${normalizeText(term)}`);
        break;
      }
    }
  }

  for (const keyword of keywords) {
    const normalized = normalizeText(keyword);
    if (normalized === 'manga') continue; // tratado pela regra de contexto abaixo
    if (hasWord(text, normalized)) {
      reasons.push(`palavra-chave: ${normalized}`);
    }
  }

  if (hasWord(text, 'manga') && isMangaContextual(text)) {
    reasons.push('palavra-chave: manga');
  }

  // Padrões editoriais ajudam a detectar livros cujo título não traz a palavra
  // "livro" (ex.: "Dom Casmurro (Edição de Bolso)", "Box Game of Thrones 7 volumes").
  for (const pattern of EDITORIAL_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push(`padrão editorial: ${pattern.source}`);
      break;
    }
  }

  if (PUBLISHERS.some((name) => text.includes(normalizeText(name)))) {
    reasons.push('editora detectada');
  }

  if (reasons.length && (isDeviceHardware(text) || categoryContainsDevice(categoryText))) {
    return { excluded: false, reasons: ['dispositivo eletronico permitido (kindle, tablet, leitor ou acessorio)'] };
  }

  const uniqueReasons = [...new Set(reasons)];
  return { excluded: uniqueReasons.length > 0, reasons: uniqueReasons };
}

function categoryContainsDevice(categoryText) {
  return DEVICE_INDICATORS.some(
    (term) => categoryText.includes(normalizeText(term)) || hasWord(categoryText, 'kindle')
  );
}

export function isExcludedProduct(product, options = {}) {
  const result = analyzeExclusion(product, options);
  if (result.excluded) {
    logger.debug('Produto bloqueado pelo filtro de conteúdo.', result.reasons);
  }
  return result.excluded;
}

export function exclusionMessage(reasons = []) {
  const list = reasons.length ? String(reasons.join(', ')) : 'conteúdo não permitido';
  return `Produto bloqueado pelo filtro de conteúdo (${list}). Livros, e-books, audiolivros, mangás, HQs, revistas, apostilas, enciclopédias e dicionários não são cadastrados nem publicados.`;
}

export function createExclusionFilter(config = {}) {
  const options = {
    extraCategories: config?.excludedCategories,
    extraKeywords: config?.excludedKeywords
  };
  return (product) => analyzeExclusion(product, options);
}

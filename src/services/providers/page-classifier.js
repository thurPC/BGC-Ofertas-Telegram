export const PAGE_TYPES = Object.freeze({
  PRODUCT: 'PRODUCT',
  COUPON: 'COUPON',
  CAMPAIGN: 'CAMPAIGN',
  STORE: 'STORE',
  CATEGORY: 'CATEGORY',
  UNKNOWN: 'UNKNOWN'
});

export const PAGE_TYPE_LABELS = Object.freeze({
  [PAGE_TYPES.PRODUCT]: 'produto individual',
  [PAGE_TYPES.COUPON]: 'página de cupons',
  [PAGE_TYPES.CAMPAIGN]: 'campanha promocional',
  [PAGE_TYPES.STORE]: 'página da loja',
  [PAGE_TYPES.CATEGORY]: 'categoria',
  [PAGE_TYPES.UNKNOWN]: 'página não identificada'
});

// Regras por plataforma, avaliadas sobre caminho + query + metadados.
const URL_RULES = [
  { type: PAGE_TYPES.COUPON, re: /\/(?:m\/)?(?:cupom|cupons|coupon|coupons)(?:[-/]|$)/i },
  { type: PAGE_TYPES.COUPON, re: /[?&](?:coupon|cupom)=/i },
  { type: PAGE_TYPES.STORE, re: /\/(?:shop|loja|store|seller|vendedor)(?:\/|$)/i },
  { type: PAGE_TYPES.CAMPAIGN, re: /\/(?:m\/)?(?:campanha|campaign|promocao|promocoes|promo|especial|evento|black|festival|mission|oferta)(?:[-/]|$)/i },
  { type: PAGE_TYPES.CAMPAIGN, re: /\/hz\/(?:mobile\/)?(?:mission|event|promo)/i },
  { type: PAGE_TYPES.CATEGORY, re: /\/(?:categorias?|categories?|departamentos?|busca|search|listagem|ofertas-do-dia)(?:\/|$)/i }
];

// Títulos que são rótulos de página, não nomes de produto.
const PLACEHOLDER_TITLE_PATTERNS = [
  /^amazon(?:\.com(?:\.br)?)?\s*[:\-]/i,
  /continue comprando/i,
  /robot check/i,
  /^just a moment/i,
  /^access denied/i,
  /^attention required/i,
  /^p[aá]gina n[aã]o encontrada/i,
  /^not found/i,
  /^cupons?\b/i,
  /^checkout/i,
  /^carrinho/i
];

export function isPlaceholderTitle(title) {
  const value = String(title ?? '').trim();
  if (!value) return true;
  return PLACEHOLDER_TITLE_PATTERNS.some((re) => re.test(value));
}

const PATH_PRODUCT_RULES = {
  amazon: [/\/(?:dp|gp\/product|gp\/aw\/d|product|d)\/[A-Z0-9]{10}/i],
  mercadolivre: [/\/(?:p|MLB|up)\/?-?[A-Z0-9]*MLB-?\d+/i, /\/MLB-?\d+/i],
  shopee: [/\/product\/\d+\/\d+/i, /-i\.\d+\.\d+/i],
  generic: [/\/product\//i, /\/produto\//i, /\/p\//i]
};

function detectProductByPath(platformId, url) {
  const rules = PATH_PRODUCT_RULES[platformId] || [];
  return [...rules, ...PATH_PRODUCT_RULES.generic].some((re) => re.test(url));
}

function normalizeType(value) {
  return String(value ?? '').toLowerCase();
}

/**
 * Classifica o destino. Nunca trata automaticamente todo link como produto:
 * páginas de cupons/campanhas/loja/categoria são reconhecidas pelo caminho,
 * pela URL final resolvida e por sinais de metadados (Open Graph/JSON-LD).
 */
export function classifyPage({ url, finalUrl, platform, meta = {}, jsonLdTypes = [], hasProductData = false } = {}) {
  const target = String(finalUrl || url || '');
  const ogType = normalizeType(meta['og:type']);
  const siteName = normalizeType(meta['og:site_name']);
  const types = jsonLdTypes.map(normalizeType);

  if (types.includes('product') || hasProductData) return { type: PAGE_TYPES.PRODUCT, confidence: 0.9 };

  if (detectProductByPath(platform?.id, target)) {
    return { type: PAGE_TYPES.PRODUCT, confidence: 0.75 };
  }

  for (const rule of URL_RULES) {
    if (rule.re.test(target)) {
      const confidence = rule.type === PAGE_TYPES.COUPON ? 0.85 : 0.6;
      return { type: rule.type, confidence };
    }
  }

  if (ogType === 'product' || ogType === 'product.group' || ogType === 'og:product') {
    return { type: PAGE_TYPES.PRODUCT, confidence: 0.7 };
  }
  if (ogType === 'website' && /shopee|cupom/.test(siteName)) {
    return { type: PAGE_TYPES.UNKNOWN, confidence: 0.4 };
  }

  return { type: PAGE_TYPES.UNKNOWN, confidence: 0.2 };
}

export function isProductPage(type) {
  return type === PAGE_TYPES.PRODUCT;
}

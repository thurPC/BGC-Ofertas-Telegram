import dns from 'node:dns/promises';
import { parseBrazilianPrice, roundMoney } from './validation-service.js';

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_HTML_CHARS = 1_000_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const COUPON_STOPWORDS = new Set([
  'DE', 'DO', 'DA', 'NO', 'NA', 'PARA', 'POR', 'UM', 'UMA', 'AQUI', 'VOCE', 'ESTE', 'ESTA',
  'ISSO', 'COM', 'SEM', 'TODO', 'TODA', 'ESSE', 'ESSA', 'MAIS', 'MUITO', 'SUPER', 'HOJE',
  'NOVA', 'NOVO', 'GRATIS', 'VALIDO', 'VALIDA', 'DISPONIVEL', 'EXCLUSIVO', 'MELI', 'PIX',
  'DESCONTO', 'OFERTA', 'PROMOCAO', 'CUPOM', 'APLICAR', 'GANHE', 'GANHAR'
]);

export const PLATFORMS = [
  {
    id: 'shopee',
    name: 'Shopee',
    hosts: ['shopee.com.br', 'shopee.com', 'shope.ee', 's.shopee.com.br']
  },
  {
    id: 'mercadolivre',
    name: 'Mercado Livre',
    hosts: ['mercadolivre.com.br', 'mercadolibre.com.br', 'mercadolibre.com', 'mercadoliv.re']
  },
  {
    id: 'amazon',
    name: 'Amazon',
    hosts: ['amazon.com.br', 'amazon.com', 'amzn.to', 'amzn.com.br', 'a.co']
  }
];

function hostMatches(host, candidates) {
  const value = String(host || '').toLowerCase();
  return candidates.some((candidate) => value === candidate || value.endsWith(`.${candidate}`));
}

export function detectPlatform(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return { id: 'generic', name: null, host: null };
  }
  for (const platform of PLATFORMS) {
    if (hostMatches(host, platform.hosts)) {
      return { id: platform.id, name: platform.name, host };
    }
  }
  return { id: 'generic', name: null, host };
}

export function isPrivateHostname(host) {
  const value = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!value) return true;
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (value.endsWith('.local') || value.endsWith('.internal') || value.endsWith('.home.arpa')) return true;
  if (value === 'metadata.google.internal') return true;
  return false;
}

export function isPrivateIp(ip) {
  const value = String(ip || '').trim().toLowerCase();
  if (!value) return true;
  if (value.includes(':')) {
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fc') || value.startsWith('fd')) return true;
    if (value.startsWith('fe80')) return true;
    if (value.startsWith('::ffff:')) return isPrivateIp(value.slice(7));
    return false;
  }
  const parts = value.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function defaultLookup(host, options) {
  return dns.lookup(host, options);
}

export async function assertPublicHttpUrl(url, { lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, error: 'URL inválida.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'Somente URLs http ou https são aceitas.' };
  }
  const host = parsed.hostname;
  if (isPrivateHostname(host)) {
    return { ok: false, error: 'Endereço interno não é permitido.' };
  }
  const bare = host.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':')) {
    if (isPrivateIp(bare)) return { ok: false, error: 'Endereço interno não é permitido.' };
    return { ok: true, value: parsed.toString() };
  }
  const resolver = typeof lookup === 'function' ? lookup : defaultLookup;
  let addresses;
  try {
    addresses = await resolver(host, { all: true });
  } catch {
    return { ok: false, error: 'Não foi possível resolver o endereço do link.' };
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length) return { ok: false, error: 'Endereço não resolvido.' };
  if (list.some((entry) => isPrivateIp(entry?.address))) {
    return { ok: false, error: 'Endereço interno não é permitido.' };
  }
  return { ok: true, value: parsed.toString() };
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2f': '/',
  '#47': '/'
};

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code) => {
    const key = code.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ENTITIES, key)) return ENTITIES[key];
    if (key.startsWith('#x')) {
      const parsed = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : full;
    }
    if (key.startsWith('#')) {
      const parsed = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : full;
    }
    return full;
  });
}

export function parseAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = re.exec(tag))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

export function collectMetaTags(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = parseAttributes(match[0]);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (!key || attrs.content == null) continue;
    if (out[key] == null) out[key] = attrs.content;
  }
  return out;
}

export function collectJsonLd(html) {
  const blocks = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // bloco JSON-LD inválido é ignorado, nunca inventamos dados
    }
  }
  return blocks;
}

function flattenNodes(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenNodes(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value['@graph'])) flattenNodes(value['@graph'], out);
    else out.push(value);
  }
  return out;
}

function findProductNode(nodes) {
  return nodes.find((node) => {
    const type = node?.['@type'];
    return Array.isArray(type) ? type.includes('Product') : type === 'Product';
  }) || null;
}

export function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

function toMoney(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? roundMoney(value) : null;
  }
  const parsed = parseBrazilianPrice(value);
  return parsed.ok ? parsed.value : null;
}

function firstNonNull(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== '') return value;
  }
  return null;
}

function absoluteUrl(value, base) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

function htmlTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : null;
}

function offersList(product) {
  const offers = product?.offers;
  if (Array.isArray(offers)) return offers;
  return offers ? [offers] : [];
}

function jsonLdPrice(product) {
  for (const offer of offersList(product)) {
    const money = toMoney(offer?.price ?? offer?.priceSpecification?.price ?? offer?.lowPrice);
    if (money != null) return money;
  }
  return null;
}

function jsonLdListPrice(product) {
  for (const offer of offersList(product)) {
    const spec = offer?.priceSpecification;
    const typed = spec && /list/i.test(String(spec.priceType || '')) ? spec.price : null;
    const money = toMoney(offer?.listPrice ?? offer?.highPrice ?? typed);
    if (money != null) return money;
  }
  return null;
}

function jsonLdImage(product) {
  const image = product?.image;
  if (!image) return null;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) {
    const first = image.find((entry) => typeof entry === 'string') || image[0]?.url;
    return first || null;
  }
  if (typeof image === 'object') return image.url || image.contentUrl || null;
  return null;
}

function jsonLdStore(product) {
  const brand = product?.brand;
  if (typeof brand === 'string') return brand;
  if (brand && typeof brand === 'object') return brand.name || null;
  const seller = product?.offers?.seller;
  if (seller && typeof seller === 'object') return seller.name || null;
  return null;
}

function isCouponLike(code, { explicit }) {
  if (code.length < 3 || code.length > 20) return false;
  if (COUPON_STOPWORDS.has(code)) return false;
  if (/^\d+$/.test(code)) return false;
  if (/\d/.test(code)) return true;
  // Código só com letras é aceito apenas quando rotulado de forma explícita (ex.: "Cupom: BGCBLACK").
  return explicit && code.length >= 4;
}

export function findCoupon(text) {
  const source = String(text ?? '');
  const patterns = [
    { re: /cupom(?:\s+de\s+desconto)?\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9_-]{2,19})/i, explicit: true },
    { re: /(?:use|utilize|aplique|aplicar|insira|com\s+o)\s+(?:o\s+)?cupom(?:\s+de\s+desconto)?\s+([A-Za-z0-9][A-Za-z0-9_-]{2,19})/i, explicit: false }
  ];
  for (const { re, explicit } of patterns) {
    const match = source.match(re);
    if (!match) continue;
    const code = String(match[1]).replace(/[.,;:]+$/, '').toUpperCase();
    if (isCouponLike(code, { explicit })) return code;
  }
  return null;
}

export function findPriceInText(text) {
  const source = String(text ?? '');
  const deal = source.match(/de\s*R\$\s*([\d.]{1,12},\d{2})\s*(?:por|a)\s*R\$\s*([\d.]{1,12},\d{2})/i);
  if (deal) {
    const previousPrice = toMoney(deal[1]);
    const price = toMoney(deal[2]);
    if (price != null) return { price, previousPrice };
  }
  const single = source.match(/R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/);
  if (single) {
    const price = toMoney(single[1]);
    if (price != null) return { price, previousPrice: null };
  }
  return { price: null, previousPrice: null };
}

export function extractFromHtml(html, baseUrl, platform = {}) {
  const meta = collectMetaTags(html);
  const product = findProductNode(flattenNodes(collectJsonLd(html)));
  const text = stripTags(html);

  const name = firstNonNull(meta['og:title'], meta['twitter:title'], product?.name, htmlTitle(html));

  const metaPrice = toMoney(firstNonNull(meta['product:price:amount'], meta['og:price:amount'], meta['twitter:data1']));
  const textPrice = findPriceInText(text);
  const price = firstNonNull(metaPrice, jsonLdPrice(product), textPrice.price);

  const metaPrevious = toMoney(
    firstNonNull(meta['product:original_price:amount'], meta['og:price:standard_amount'], meta['product:price:standard_amount'])
  );
  const previousCandidate = firstNonNull(metaPrevious, jsonLdListPrice(product), textPrice.previousPrice);
  const previousPrice = previousCandidate != null && price != null && previousCandidate > price ? previousCandidate : null;

  const rawImage = firstNonNull(meta['og:image'], meta['og:image:secure_url'], meta['twitter:image'], jsonLdImage(product));
  const imageUrl = absoluteUrl(rawImage, baseUrl);

  const store = firstNonNull(platform?.name, meta['og:site_name'], jsonLdStore(product));

  const coupon = findCoupon(text);

  return {
    name: name ? String(name).trim().slice(0, 180) : null,
    price: price ?? null,
    previousPrice: previousPrice ?? null,
    imageUrl,
    store: store ? String(store).trim().slice(0, 80) : null,
    coupon: coupon || null
  };
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

export async function safeFetch(url, options = {}) {
  const fetcher = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (typeof fetcher !== 'function') {
    return { ok: false, error: 'Cliente HTTP indisponível.', reason: 'no-fetch' };
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS;
  let current = String(url);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const safety = await assertPublicHttpUrl(current, { lookup: options.lookup });
    if (!safety.ok) return { ok: false, error: safety.error, reason: 'unsafe-url' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetcher(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
      });
    } catch (error) {
      const aborted = error?.name === 'AbortError' || /abort|timeout/i.test(String(error?.message || ''));
      return {
        ok: false,
        error: aborted ? 'Tempo esgotado ao consultar a página.' : 'Falha de rede ao consultar a página.',
        reason: aborted ? 'timeout' : 'network'
      };
    } finally {
      clearTimeout(timer);
    }

    const status = response?.status ?? 200;
    if (REDIRECT_STATUS.has(status)) {
      const location = headerValue(response, 'location');
      if (!location) return { ok: false, error: 'Redirecionamento sem destino.', reason: 'bad-redirect' };
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, error: 'Redirecionamento inválido.', reason: 'bad-redirect' };
      }
      continue;
    }
    return { ok: true, response, finalUrl: current };
  }
  return { ok: false, error: 'Muitos redirecionamentos.', reason: 'too-many-redirects' };
}

export async function extractOfferFromLink(rawUrl, options = {}) {
  const url = String(rawUrl ?? '').trim();
  const platform = detectPlatform(url);

  const fetched = await safeFetch(url, options);
  if (!fetched.ok) {
    return { ok: false, error: fetched.error, reason: fetched.reason, platform };
  }

  const { response, finalUrl } = fetched;
  const status = response?.status ?? 200;
  const isOk = response?.ok ?? (status >= 200 && status < 300);
  if (!isOk) {
    return { ok: false, error: `A página respondeu HTTP ${status}.`, reason: 'http-error', platform };
  }

  let html;
  try {
    html = await response.text();
  } catch {
    return { ok: false, error: 'Não foi possível ler a página.', reason: 'read-error', platform };
  }
  if (!String(html || '').trim()) {
    return { ok: false, error: 'A página retornou conteúdo vazio.', reason: 'empty', platform };
  }

  const data = extractFromHtml(String(html).slice(0, MAX_HTML_CHARS), finalUrl, platform);

  const warnings = [];
  if (!data.imageUrl) warnings.push('image-missing');
  if (!data.coupon) warnings.push('coupon-missing');
  if (data.price == null) warnings.push('price-missing');

  const offer = { ...data, url };
  const missing = [];
  if (!offer.name) missing.push('name');
  if (offer.price == null) missing.push('price');

  return { ok: true, offer, platform, finalUrl, missing, warnings };
}

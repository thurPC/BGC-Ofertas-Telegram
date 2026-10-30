import { escapeHtml, formatBRL } from './validation-service.js';

export const TEMPLATE_VERSION = 1;

export const BRAND = 'BGC PROMOS';

export const FIELD_KEYS = [
  'title',
  'price',
  'coupon',
  'previousPrice',
  'pixPrice',
  'store',
  'conditions',
  'validity',
  'productLink',
  'share'
];

export const BLOCK_KEYS = new Set(['title', 'productLink', 'share']);

export const OPTIONAL_KEYS = ['previousPrice', 'pixPrice', 'store', 'conditions', 'validity'];

export const DEFAULT_TEMPLATE = {
  version: TEMPLATE_VERSION,
  brand: BRAND,
  order: ['title', 'price', 'coupon', 'productLink', 'share'],
  emojis: {
    title: '🔥',
    price: '💰',
    coupon: '🎟️',
    previousPrice: '💸',
    pixPrice: '💳',
    store: '🏪',
    conditions: '📌',
    validity: '⏳',
    productLink: '🔗',
    share: '👉'
  },
  labels: {
    coupon: 'Cupom',
    previousPrice: 'De',
    pixPrice: 'PIX',
    store: 'Loja',
    conditions: 'Condições',
    validity: 'Válida até',
    productLink: 'Link do produto',
    share: 'Compartilhe com os amigos'
  },
  priceFormat: 'R$ {valor}',
  optional: {
    previousPrice: false,
    pixPrice: false,
    store: false,
    conditions: false,
    validity: false
  },
  channelLink: ''
};

function asText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value);
  return text;
}

function normalizeOrder(order) {
  if (!Array.isArray(order)) return [...DEFAULT_TEMPLATE.order];
  const seen = new Set();
  const result = [];
  for (const key of order) {
    const name = String(key ?? '').trim();
    if (!FIELD_KEYS.includes(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result.length ? result : [...DEFAULT_TEMPLATE.order];
}

function mergeRecord(base, patch) {
  const result = { ...base };
  if (patch && typeof patch === 'object') {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) continue;
      result[key] = value;
    }
  }
  return result;
}

export function mergeTemplate(patch = {}) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const emojis = mergeRecord(DEFAULT_TEMPLATE.emojis, source.emojis);
  const labels = mergeRecord(DEFAULT_TEMPLATE.labels, source.labels);
  const optional = mergeRecord(DEFAULT_TEMPLATE.optional, source.optional);

  for (const key of Object.keys(emojis)) {
    if (!FIELD_KEYS.includes(key)) delete emojis[key];
  }
  for (const key of Object.keys(labels)) {
    if (!FIELD_KEYS.includes(key)) delete labels[key];
  }
  for (const key of Object.keys(optional)) {
    if (!OPTIONAL_KEYS.includes(key)) delete optional[key];
  }

  return {
    version: TEMPLATE_VERSION,
    brand: asText(source.brand, DEFAULT_TEMPLATE.brand) || DEFAULT_TEMPLATE.brand,
    order: normalizeOrder(source.order ?? DEFAULT_TEMPLATE.order),
    emojis,
    labels,
    priceFormat: asText(source.priceFormat, DEFAULT_TEMPLATE.priceFormat) || DEFAULT_TEMPLATE.priceFormat,
    optional,
    channelLink: asText(source.channelLink, '').trim()
  };
}

export function defaultTemplate() {
  return mergeTemplate(DEFAULT_TEMPLATE);
}

export function formatPriceValue(value, format) {
  const formatted = formatBRL(value);
  const pattern = asText(format, DEFAULT_TEMPLATE.priceFormat).trim() || DEFAULT_TEMPLATE.priceFormat;
  if (pattern.includes('{valor}')) return pattern.replaceAll('{valor}', formatted);
  return `${pattern} ${formatted}`.trim();
}

function renderField(key, offer, template, channelLink) {
  const emoji = template.emojis[key] ?? '';
  const label = template.labels[key] ?? '';
  const withEmoji = (text) => (emoji ? `${emoji} ${text}` : text);
  const inline = !BLOCK_KEYS.has(key);

  switch (key) {
    case 'title': {
      const name = String(offer?.name ?? '').trim();
      if (!name) return null;
      return { inline, text: withEmoji(escapeHtml(name)) };
    }
    case 'price': {
      if (offer?.price == null) return null;
      return { inline, text: withEmoji(escapeHtml(formatPriceValue(offer.price, template.priceFormat))) };
    }
    case 'coupon': {
      const coupon = String(offer?.coupon ?? '').trim();
      if (!coupon) return null;
      const prefix = label ? `${escapeHtml(label)}: ` : '';
      return { inline, text: withEmoji(`${prefix}${escapeHtml(coupon)}`) };
    }
    case 'previousPrice': {
      if (!template.optional.previousPrice || offer?.previousPrice == null) return null;
      const prefix = label ? `${escapeHtml(label)}: ` : '';
      return { inline, text: withEmoji(`${prefix}${escapeHtml(formatPriceValue(offer.previousPrice, template.priceFormat))}`) };
    }
    case 'pixPrice': {
      if (!template.optional.pixPrice || offer?.pixPrice == null) return null;
      const prefix = label ? `${escapeHtml(label)}: ` : '';
      return { inline, text: withEmoji(`${prefix}${escapeHtml(formatPriceValue(offer.pixPrice, template.priceFormat))}`) };
    }
    case 'store': {
      const store = String(offer?.store ?? '').trim();
      if (!template.optional.store || !store) return null;
      const prefix = label ? `${escapeHtml(label)}: ` : '';
      return { inline, text: withEmoji(`${prefix}${escapeHtml(store)}`) };
    }
    case 'conditions': {
      const conditions = String(offer?.couponConditions ?? '').trim();
      if (!template.optional.conditions || !conditions) return null;
      const prefix = label ? `${escapeHtml(label)}: ` : '';
      return { inline, text: withEmoji(`${prefix}${escapeHtml(conditions)}`) };
    }
    case 'validity': {
      if (!template.optional.validity || !offer?.validUntil) return null;
      const date = new Date(offer.validUntil);
      if (Number.isNaN(date.getTime())) return null;
      const prefix = label ? `${escapeHtml(label)}: ` : '';
      return { inline, text: withEmoji(`${prefix}${escapeHtml(date.toLocaleString('pt-BR'))}`) };
    }
    case 'productLink': {
      const url = String(offer?.url ?? '').trim();
      if (!url) return null;
      const heading = label ? `${escapeHtml(label)}:` : '';
      const head = withEmoji(heading).trim();
      return { inline, text: head ? `${head}\n${escapeHtml(url)}` : escapeHtml(url) };
    }
    case 'share': {
      const link = String(channelLink ?? '').trim();
      if (!link) return null;
      const heading = label ? `${escapeHtml(label)}:` : '';
      const head = withEmoji(heading).trim();
      return { inline, text: head ? `${head}\n${escapeHtml(link)}` : escapeHtml(link) };
    }
    default:
      return null;
  }
}

export function renderOfferMessage(offer, { template, channelLink } = {}) {
  const resolved = mergeTemplate(template ?? DEFAULT_TEMPLATE);
  const link = String(channelLink ?? resolved.channelLink ?? '').trim();

  let out = '';
  let previousInline = false;
  for (const key of resolved.order) {
    const piece = renderField(key, offer, resolved, link);
    if (!piece) continue;
    const separator = out === '' ? '' : piece.inline && previousInline ? '\n' : '\n\n';
    out += separator + piece.text;
    previousInline = piece.inline;
  }
  return out;
}

export function describeTemplate(template) {
  const t = mergeTemplate(template);
  const lines = [
    `<b>Modelo atual — ${escapeHtml(t.brand)}</b>`,
    '',
    `<b>Ordem:</b> ${t.order.map((key) => escapeHtml(key)).join(' → ')}`,
    `<b>Formato de preço:</b> <code>${escapeHtml(t.priceFormat)}</code>`,
    `<b>Link do canal:</b> ${t.channelLink ? escapeHtml(t.channelLink) : '<i>não configurado</i>'}`,
    '',
    '<b>Campos opcionais ativos:</b>'
  ];
  const active = OPTIONAL_KEYS.filter((key) => t.optional[key]);
  lines.push(active.length ? active.map((key) => `• ${escapeHtml(key)}`).join('\n') : '• nenhum');
  return lines.join('\n');
}

export class TemplateService {
  constructor(storage) {
    this.storage = storage;
  }

  async get() {
    if (!this.storage) return defaultTemplate();
    const db = await this.storage.read();
    return mergeTemplate(db.settings?.template ?? DEFAULT_TEMPLATE);
  }

  async update(patch, { actorId } = {}) {
    const current = await this.get();
    const next = mergeTemplate({ ...current, ...patch });
    if (!this.storage) return next;
    await this.storage.update((db) => {
      db.settings = { ...db.settings, template: next };
      db.history.push({
        at: new Date().toISOString(),
        action: 'template-update',
        actorId: actorId ?? null
      });
      return db;
    });
    return next;
  }

  async reset({ actorId } = {}) {
    const next = defaultTemplate();
    if (!this.storage) return next;
    await this.storage.update((db) => {
      db.settings = { ...db.settings, template: null };
      db.history.push({
        at: new Date().toISOString(),
        action: 'template-reset',
        actorId: actorId ?? null
      });
      return db;
    });
    return next;
  }
}

import { isShopeeProductUrl, extractShopeeIds } from '../services/shopee-affiliate-client.js';

function cleanUrl(value) {
  return String(value ?? '').replace(/[),.!?;]+$/g, '');
}

function urlsFromMessage(message, text) {
  const found = [];
  const entities = [...(message?.entities || []), ...(message?.caption_entities || [])];
  for (const entity of entities) {
    if (entity?.type === 'text_link' && entity.url) found.push(entity.url);
  }
  for (const match of String(text ?? '').matchAll(/https?:\\/\\/[^\\s<>]+/gi)) {
    found.push(cleanUrl(match[0]));
  }
  return [...new Set(found.map(cleanUrl))];
}

function parsePrice(text) {
  const match = String(text ?? '').match(/R\\$\\s*([\\d.]+,\\d{2}|[\\d.]+)/i);
  if (!match) return null;
  const value = Number(match[1].replace(/\\./g, '').replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
}

function parseCoupon(text) {
  const match = String(text ?? '').match(/(?:cupom|coupon)\\s*(?:shopee)?\\s*[:：-]\\s*([A-Z0-9_-]{3,32})/i);
  return match ? match[1].toUpperCase() : null;
}

export function parseShopeeChannelPost(message = {}) {
  const text = String(message.text || message.caption || '').trim();
  if (!text) return null;
  const productUrl = urlsFromMessage(message, text).find(isShopeeProductUrl);
  if (!productUrl) return null;

  const ids = extractShopeeIds(productUrl);
  const title = text.split(/\\r?\\n/).map((line) => line.trim()).find((line) => line && !/^https?:\\/\\//i.test(line)) || null;
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  if (chatId == null || messageId == null) return null;

  return {
    status: 'discovered',
    marketplace: 'Shopee',
    sourceChatId: String(chatId),
    sourceChatTitle: message.chat?.title || null,
    sourceMessageId: String(messageId),
    sourceDate: message.date ? new Date(Number(message.date) * 1000).toISOString() : null,
    title,
    rawText: text,
    productUrl,
    shopId: ids?.shopId || null,
    itemId: ids?.itemId || null,
    price: parsePrice(text),
    coupon: parseCoupon(text),
    discoveredAt: new Date().toISOString(),
    sources: [{ chatId: String(chatId), messageId: String(messageId) }]
  };
}

export function puxadorProductKey(capture) {
  if (capture?.shopId && capture?.itemId) return `shopee:${capture.shopId}:${capture.itemId}`;
  try {
    const url = new URL(capture?.productUrl);
    url.search = '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\\./, '');
    return url.toString().replace(/\\/$/, '');
  } catch {
    return null;
  }
}

import { escapeHtml, telegramCaptionLimitOk, telegramMessageLimitOk } from '../services/validation-service.js';
import { defaultTemplate, renderOfferMessage } from '../services/template-service.js';

export function formatOfferHtml(offer, options = {}) {
  const template = options.template ?? defaultTemplate();
  const channelLink = options.channelLink ?? template.channelLink ?? '';
  return renderOfferMessage(offer, { template, channelLink });
}

export function chooseSendMode(offer, html) {
  const photo = offer.imageUrl || offer.imageFileId || null;
  const hasImage = Boolean(photo);
  if (hasImage && telegramCaptionLimitOk(html)) {
    return { method: 'sendPhoto', text: html, photo };
  }
  if (!telegramMessageLimitOk(html)) {
    const truncated = `${html.slice(0, 4000)}\n…`;
    return { method: 'sendMessage', text: truncated, photo: null, truncated: true };
  }
  return { method: 'sendMessage', text: html, photo: hasImage ? photo : null };
}

export function formatOfferPreview(offer, options = {}) {
  const html = formatOfferHtml(offer, options);
  const status = offer.status ? `\n\nEstado: <b>${escapeHtml(offer.status)}</b>` : '';
  const id = offer.id ? `\nID: <code>${escapeHtml(offer.id)}</code>` : '';
  return `${html}${status}${id}`;
}

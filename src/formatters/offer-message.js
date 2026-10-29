import {
  calculateDiscount,
  escapeHtml,
  formatBRL,
  telegramCaptionLimitOk,
  telegramMessageLimitOk
} from '../services/validation-service.js';

function line(text) {
  return text ? `${text}\n` : '';
}

export function formatOfferHtml(offer) {
  const name = escapeHtml(offer.name || 'Produto');
  const parts = [];

  parts.push(`🔥 <b>${name}</b>`);
  parts.push('');

  if (offer.price != null) {
    parts.push(`💰 Preço promocional: R$ ${formatBRL(offer.price)}`);
  }

  if (offer.previousPrice != null) {
    parts.push(`💸 De: R$ ${formatBRL(offer.previousPrice)}`);
  }

  if (offer.pixPrice != null) {
    parts.push(`💳 PIX: R$ ${formatBRL(offer.pixPrice)}`);
  }

  const discount = calculateDiscount(offer.previousPrice, offer.price);
  if (discount != null) {
    parts.push(`📉 Economia: ${formatBRL(discount)}%`);
  }

  if (offer.coupon) {
    parts.push(`🏷️ Cupom: <code>${escapeHtml(offer.coupon)}</code>`);
  }

  if (offer.couponConditions) {
    parts.push(`📌 Condições: ${escapeHtml(offer.couponConditions)}`);
  }

  if (offer.store) {
    parts.push(`🏪 Loja: ${escapeHtml(offer.store)}`);
  }

  if (offer.validUntil) {
    const date = new Date(offer.validUntil);
    if (!Number.isNaN(date.getTime())) {
      parts.push(`⏳ Válida até: ${escapeHtml(date.toLocaleString('pt-BR'))}`);
    }
  }

  if (offer.url) {
    parts.push('');
    parts.push(`🛒 Link de compra: ${escapeHtml(offer.url)}`);
  }

  parts.push('');
  parts.push('📢 Compartilhe com seus amigos!');

  return parts.filter((item, index, arr) => !(item === '' && arr[index - 1] === '')).join('\n');
}

export function chooseSendMode(offer, html) {
  const hasImage = Boolean(offer.imageUrl);
  if (hasImage && telegramCaptionLimitOk(html)) {
    return { method: 'sendPhoto', text: html, photo: offer.imageUrl };
  }
  if (!telegramMessageLimitOk(html)) {
    const truncated = `${html.slice(0, 4000)}\n…`;
    return { method: 'sendMessage', text: truncated, photo: null, truncated: true };
  }
  return { method: 'sendMessage', text: html, photo: hasImage ? offer.imageUrl : null };
}

export function formatOfferPreview(offer) {
  const html = formatOfferHtml(offer);
  const status = offer.status ? `\nEstado: <b>${escapeHtml(offer.status)}</b>` : '';
  const id = offer.id ? `\nID: <code>${escapeHtml(offer.id)}</code>` : '';
  return `${html}${status}${id}`;
}

export { line };

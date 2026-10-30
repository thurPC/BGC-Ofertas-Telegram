import { confirmPublishKeyboard } from '../commands/admin.js';
import { extractOfferFromLink } from './link-extractor.js';
import { escapeHtml } from './validation-service.js';

export const WARNING_TEXT = {
  'image-missing': '🖼️ Imagem não encontrada. Adicione a imagem real antes de publicar ou a publicação sairá somente com texto.',
  'coupon-missing': '🎟️ Nenhum cupom encontrado na página.',
  'price-missing': '💰 Preço não encontrado na página. Informe manualmente.'
};

export function platformLabel(platform) {
  return platform?.name || 'Loja';
}

export function analyzeLink(rawUrl, options = {}) {
  return extractOfferFromLink(rawUrl, options);
}

export function extractionSummary({ offer = {}, platform, warnings = [] }) {
  const lines = [`🔎 <b>Link analisado</b> — ${escapeHtml(platformLabel(platform))}`, ''];
  lines.push(`Título: ${offer.name ? escapeHtml(offer.name) : '<i>não identificado</i>'}`);
  lines.push(
    offer.price != null
      ? `Preço: R$ ${escapeHtml(String(offer.price).replace('.', ','))}`
      : 'Preço: <i>não identificado</i>'
  );
  if (offer.previousPrice != null) lines.push(`Preço anterior: R$ ${escapeHtml(String(offer.previousPrice).replace('.', ','))}`);
  lines.push(`Cupom: ${offer.coupon ? escapeHtml(offer.coupon) : '<i>nenhum</i>'}`);
  lines.push(`Imagem: ${offer.imageUrl ? 'encontrada' : '<i>não encontrada</i>'}`);
  lines.push(`Loja: ${offer.store ? escapeHtml(offer.store) : '<i>não identificada</i>'}`);
  lines.push('');
  lines.push(`🔗 Link preservado integralmente (afiliado mantido).`);

  const notes = warnings.map((code) => WARNING_TEXT[code]).filter(Boolean);
  if (notes.length) {
    lines.push('');
    lines.push(...notes);
  }
  return lines.join('\n');
}

export function previewKeyboard(tempId) {
  return confirmPublishKeyboard(String(tempId));
}

export function missingFieldsMessage(missing = []) {
  const labels = { name: 'título', price: 'preço', store: 'loja' };
  const list = missing.map((field) => labels[field] || field).join(', ');
  return `Não foi possível identificar: <b>${escapeHtml(list)}</b>. Vou pedir somente o que falta.`;
}

export function invalidLinkMessage() {
  return [
    'Não foi possível analisar este link automaticamente.',
    'Nenhum dado foi inventado. Você pode:',
    '• enviar outro link, ou',
    '• usar /novaoferta para o cadastro guiado completo.'
  ].join('\n');
}

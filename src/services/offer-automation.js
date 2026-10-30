import { confirmPublishKeyboard } from '../commands/admin.js';
import { extractOfferFromLink } from './link-extractor.js';
import { escapeHtml } from './validation-service.js';

export const WARNING_TEXT = {
  'image-missing': '🖼️ Imagem não encontrada. Adicione a imagem real antes de publicar ou a publicação sairá somente com texto.',
  'coupon-missing': '🎟️ Nenhum cupom encontrado na página.',
  'price-missing': '💰 Preço não encontrado na página. Informe manualmente.',
  'price-authorized-only':
    '💰 O preço da Amazon só é exibido a partir de uma fonte autorizada (API oficial do Amazon Associados). Informe o preço manualmente.'
};

export function platformLabel(platform) {
  return platform?.name || 'Loja';
}

export function analyzeLink(rawUrl, options = {}) {
  return extractOfferFromLink(rawUrl, options);
}

function brl(value) {
  return `R$ ${escapeHtml(String(value).replace('.', ','))}`;
}

export function extractionSummary({ offer = {}, platform, warnings = [] }) {
  const store = offer.store || platformLabel(platform);
  const lines = [`🔎 <b>Link analisado</b> — ${escapeHtml(store)}`, ''];
  lines.push(`📦 Produto: ${offer.name ? escapeHtml(offer.name) : '<i>não identificado</i>'}`);
  lines.push(`🏪 Loja: ${offer.store ? escapeHtml(offer.store) : '<i>não identificada</i>'}`);
  lines.push(offer.price != null ? `💰 Preço: ${brl(offer.price)}` : '💰 Preço: <i>precisa ser informado</i>');
  if (offer.previousPrice != null) lines.push(`Preço anterior: ${brl(offer.previousPrice)}`);
  lines.push(`🎟️ Cupom: ${offer.coupon ? escapeHtml(offer.coupon) : '<i>nenhum</i>'}`);
  lines.push(`🖼️ Imagem: ${offer.imageUrl ? 'encontrada' : '<i>não encontrada</i>'}`);
  if (offer.asin) lines.push(`ASIN: <code>${escapeHtml(offer.asin)}</code>`);
  lines.push('');
  lines.push('🔗 Link de afiliado preservado integralmente.');

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

const MISSING_PROMPTS = {
  name: '📦 Qual é o nome do produto?',
  price: '💰 Qual é o preço atual? Use o formato brasileiro, por exemplo 199,90.',
  store: '🏪 Qual é a loja?'
};

export function missingFieldsPrompt(missing = []) {
  const first = missing[0];
  return MISSING_PROMPTS[first] || 'Continue o cadastro.';
}

export function invalidLinkMessage() {
  return [
    'Não foi possível analisar este link automaticamente.',
    'Nenhum dado foi inventado. Você pode:',
    '• enviar outro link, ou',
    '• usar /novaoferta para o cadastro guiado completo.'
  ].join('\n');
}

import { confirmPublishKeyboard } from '../commands/admin.js';
import { escapeHtml } from './validation-service.js';
import { createProductResolver } from './providers/product-resolver.js';
import { PAGE_TYPES, PAGE_TYPE_LABELS } from './providers/page-classifier.js';
import { REASON_TEXT } from './providers/http-client.js';

export { PAGE_TYPES, PAGE_TYPE_LABELS };

export const WARNING_TEXT = {
  'image-missing': '🖼️ Imagem não encontrada. Envie a foto do produto ou a publicação sairá somente com texto.',
  'coupon-missing': '🎟️ Nenhum cupom encontrado na página.',
  'price-missing': '💰 Preço não encontrado na página. Informe manualmente.',
  'price-authorized-only':
    '💰 O preço da Amazon só é exibido a partir de uma fonte autorizada (API oficial do Amazon Associados). Informe o preço manualmente.'
};

const DEFAULT_RESOLVER = createProductResolver();

export function platformLabel(platform) {
  return platform?.name || 'Loja';
}

// Mantém o nome `analyzeLink` usado pelo handler, agora apoiado no resolver modular.
export function analyzeLink(rawUrl, options = {}) {
  const resolver = options.resolver || DEFAULT_RESOLVER;
  return resolver.resolve(rawUrl, options);
}

function brl(value) {
  const text = Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `R$ ${escapeHtml(text)}`;
}

function confidenceLabel(entry) {
  if (entry == null) return 'não disponível';
  if (entry >= 0.75) return 'alta';
  if (entry >= 0.5) return 'média';
  return 'baixa';
}

export function extractionSummary({ offer = {}, platform, warnings = [], pageType, confidence = {} }) {
  const store = offer.store || platformLabel(platform);
  const lines = [`🔎 <b>Link analisado</b> — ${escapeHtml(store)}`, ''];
  if (pageType && pageType !== PAGE_TYPES.PRODUCT) {
    lines.push(`📄 Tipo de página: ${escapeHtml(PAGE_TYPE_LABELS[pageType] || pageType)}`);
  }
  lines.push(`📦 Produto: ${offer.name ? escapeHtml(offer.name) : '<i>não identificado</i>'}`);
  lines.push(`🏪 Loja: ${offer.store ? escapeHtml(offer.store) : '<i>não identificada</i>'}`);
  lines.push(offer.price != null ? `💰 Preço: ${brl(offer.price)}` : '💰 Preço: <i>precisa ser informado</i>');
  if (offer.previousPrice != null) lines.push(`Preço anterior: ${brl(offer.previousPrice)}`);
  lines.push(`🎟️ Cupom: ${offer.coupon ? escapeHtml(offer.coupon) : '<i>nenhum</i>'}`);
  lines.push(`🖼️ Imagem: ${offer.imageUrl ? 'encontrada' : '<i>não encontrada</i>'}`);
  if (offer.seller) lines.push(`🤝 Vendedor: ${escapeHtml(offer.seller)}`);
  if (offer.asin) lines.push(`ASIN: <code>${escapeHtml(offer.asin)}</code>`);
  if (confidence.title != null) lines.push(`Confiança do título: ${confidenceLabel(confidence.title)}`);
  lines.push('');
  lines.push('🔗 Link de afiliado preservado integralmente.');

  const notes = warnings.map((code) => WARNING_TEXT[code]).filter(Boolean);
  if (notes.length) {
    lines.push('');
    lines.push(...notes);
  }
  return lines.join('\n');
}

// Mensagem específica quando o destino não é um produto individual.
export function nonProductMessage({ pageType, platform }) {
  const store = platformLabel(platform);
  const label = PAGE_TYPE_LABELS[pageType] || 'página não identificada';
  if (pageType === PAGE_TYPES.COUPON) {
    return [
      `🎟️ Identifiquei uma <b>página de cupons</b> da ${escapeHtml(store)}, não um produto individual.`,
      'Envie o link direto do produto ou escolha cadastrar uma promoção de cupons.'
    ].join('\n');
  }
  return [
    `📄 Identifiquei uma <b>${escapeHtml(label)}</b> da ${escapeHtml(store)}, não um produto individual.`,
    'Envie o link direto do produto para continuar.'
  ].join('\n');
}

export function blockedMessage({ platform, status, error }) {
  const store = platformLabel(platform);
  const reason = error || REASON_TEXT[status] || 'A loja não respondeu como esperado.';
  return [
    `⚠️ Não foi possível ler os dados na ${escapeHtml(store)}.`,
    escapeHtml(reason),
    'Nenhum dado foi inventado. Envie o link do produto novamente ou informe os dados manualmente.'
  ].join('\n');
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

export function imageMissingPrompt() {
  return '🖼️ Sem imagem confirmada. Envie a <b>foto do produto</b> ou toque em <b>Pular</b> para publicar somente com texto.';
}

export function invalidLinkMessage() {
  return [
    'Não foi possível analisar este link automaticamente.',
    'Nenhum dado foi inventado. Você pode:',
    '• enviar outro link, ou',
    '• usar /novaoferta para o cadastro guiado completo.'
  ].join('\n');
}

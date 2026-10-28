import { confirmPublishKeyboard } from '../commands/admin.js';
import { formatOfferPreview } from '../formatters/offer-message.js';
import {
  isOptionalSkip,
  parseBrazilianPrice,
  parseValidity,
  validateHttpUrl,
  validateOptionalText,
  validateRequiredText
} from '../services/validation-service.js';

export const WIZARD_STEPS = [
  'name',
  'price',
  'previousPrice',
  'pixPrice',
  'coupon',
  'couponConditions',
  'imageUrl',
  'url',
  'store',
  'validUntil',
  'preview'
];

const PROMPTS = {
  name: '1️⃣ Informe o <b>nome do produto</b>.',
  price: '2️⃣ Qual o <b>preço atual</b>? Use o formato brasileiro, por exemplo 199,90.',
  previousPrice: '3️⃣ Preço anterior (opcional). Envie o valor ou <code>pular</code>.',
  pixPrice: '4️⃣ Preço no PIX (opcional). Envie o valor ou <code>pular</code>.',
  coupon: '5️⃣ Cupom (opcional). Envie o código ou <code>pular</code>.',
  couponConditions: '6️⃣ Condições do cupom (opcional). Envie o texto ou <code>pular</code>.',
  imageUrl: '7️⃣ URL da imagem (opcional). Envie um link http/https ou <code>pular</code>.',
  url: '8️⃣ Link de compra (obrigatório). Envie a URL completa.',
  store: '9️⃣ Qual a <b>loja</b>?',
  validUntil: '🔟 Validade (opcional). Use DD/MM/AAAA ou <code>pular</code>.'
};

export function createWizardState(userId, base = {}) {
  return {
    userId,
    step: 'name',
    data: { ...base },
    editingField: null,
    createdAt: Date.now()
  };
}

export function wizardPrompt(step) {
  return PROMPTS[step] || 'Continue o cadastro.';
}

export function applyWizardInput(state, text) {
  const step = state.editingField || state.step;
  const result = handleStep(step, text);
  if (!result.ok) return result;

  if (result.skipped) {
    if (step === 'coupon') state.data.coupon = null;
    else if (step === 'couponConditions') state.data.couponConditions = null;
    else if (step === 'previousPrice') state.data.previousPrice = null;
    else if (step === 'pixPrice') state.data.pixPrice = null;
    else if (step === 'imageUrl') state.data.imageUrl = null;
    else if (step === 'validUntil') state.data.validUntil = null;
  } else {
    state.data[step] = result.value;
  }

  if (state.editingField) {
    state.editingField = null;
    state.step = 'preview';
    return { ok: true, done: true };
  }

  const index = WIZARD_STEPS.indexOf(state.step);
  const next = WIZARD_STEPS[index + 1];
  state.step = next;
  return { ok: true, done: next === 'preview', next };
}

function handleStep(step, text) {
  switch (step) {
    case 'name':
      return validateRequiredText(text, 'Nome do produto', { max: 180 });
    case 'price': {
      const parsed = parseBrazilianPrice(text);
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.value };
    }
    case 'previousPrice':
    case 'pixPrice': {
      if (isOptionalSkip(text)) return { ok: true, skipped: true, value: null };
      const parsed = parseBrazilianPrice(text);
      if (!parsed.ok) return parsed;
      return { ok: true, value: parsed.value };
    }
    case 'coupon':
      return validateOptionalText(text, { max: 80 });
    case 'couponConditions':
      return validateOptionalText(text, { max: 300 });
    case 'imageUrl':
      return validateHttpUrl(text, { required: false, image: true });
    case 'url':
      return validateHttpUrl(text, { required: true });
    case 'store':
      return validateRequiredText(text, 'Loja', { max: 80 });
    case 'validUntil':
      return parseValidity(text);
    default:
      return { ok: false, error: 'Etapa desconhecida.' };
  }
}

export function previewPayload(state) {
  return {
    html: formatOfferPreview(state.data),
    keyboard: confirmPublishKeyboard(String(state.userId))
  };
}

export const EDIT_FIELD_KEYBOARD = {
  inline_keyboard: [
    [
      { text: 'Nome', callback_data: 'wizard:field:name' },
      { text: 'Preço', callback_data: 'wizard:field:price' }
    ],
    [
      { text: 'Preço anterior', callback_data: 'wizard:field:previousPrice' },
      { text: 'PIX', callback_data: 'wizard:field:pixPrice' }
    ],
    [
      { text: 'Cupom', callback_data: 'wizard:field:coupon' },
      { text: 'Condições', callback_data: 'wizard:field:couponConditions' }
    ],
    [
      { text: 'Imagem', callback_data: 'wizard:field:imageUrl' },
      { text: 'Link', callback_data: 'wizard:field:url' }
    ],
    [
      { text: 'Loja', callback_data: 'wizard:field:store' },
      { text: 'Validade', callback_data: 'wizard:field:validUntil' }
    ],
    [{ text: '⬅️ Voltar à prévia', callback_data: 'wizard:backpreview' }]
  ]
};

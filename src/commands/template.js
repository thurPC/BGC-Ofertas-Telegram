import { isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { escapeHtml } from '../services/validation-service.js';
import {
  BRAND,
  FIELD_KEYS,
  OPTIONAL_KEYS,
  defaultTemplate,
  describeTemplate,
  mergeTemplate,
  renderOfferMessage
} from '../services/template-service.js';

export const MODEL_HELP_TEXT = [
  '🎨 <b>Modelo de publicação — BGC PROMOS</b>',
  '',
  'Use /modelo para abrir o painel e ajustar:',
  '• Texto da publicação (rótulos)',
  '• Emojis de cada campo',
  '• Ordem dos campos',
  '• Mensagem de compartilhamento e link do canal',
  '• Formato de preço',
  '• Campos opcionais',
  '',
  'Também é possível restaurar o modelo padrão.',
  'Somente administradores autorizados podem alterar o modelo.'
].join('\n');

export function modelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🔗 Link do canal', callback_data: 'modelo:link' }],
      [{ text: '💱 Formato de preço', callback_data: 'modelo:preco' }],
      [
        { text: '😀 Emojis', callback_data: 'modelo:emoji' },
        { text: '📝 Textos', callback_data: 'modelo:texto' }
      ],
      [
        { text: '🔢 Ordem dos campos', callback_data: 'modelo:ordem' },
        { text: '➕ Campos opcionais', callback_data: 'modelo:opcionais' }
      ],
      [
        { text: '👁️ Prévia do modelo', callback_data: 'modelo:previa' },
        { text: '♻️ Restaurar padrão', callback_data: 'modelo:restaurar' }
      ],
      [{ text: '⬅️ Painel', callback_data: 'admin:home' }]
    ]
  };
}

export const SAMPLE_OFFER = {
  name: 'Notebook Gamer BGC 15"',
  price: 4299.9,
  previousPrice: 4999.9,
  pixPrice: 4099.9,
  coupon: 'BGC10',
  couponConditions: 'Somente no PIX, uma unidade por CPF',
  imageUrl: 'https://cdn.example.com/notebook.jpg',
  url: 'https://loja.example.com/notebook-gamer?afiliado=bgc&utm_source=canal',
  store: 'Loja Gamer',
  validUntil: null
};

export function samplePreview(template) {
  const t = mergeTemplate(template);
  return renderOfferMessage(SAMPLE_OFFER, {
    template: t,
    channelLink: t.channelLink || 'https://t.me/seu_canal'
  });
}

export function templatePanel(template) {
  return {
    html: `${describeTemplate(template)}\n\n<b>Prévia</b>\n\n${samplePreview(template)}`,
    keyboard: modelKeyboard()
  };
}

const MODEL_SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

export function getModelSession(userId) {
  const session = MODEL_SESSIONS.get(String(userId));
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    MODEL_SESSIONS.delete(String(userId));
    return null;
  }
  return session;
}

export function setModelSession(userId, session) {
  MODEL_SESSIONS.set(String(userId), { ...session, createdAt: Date.now() });
}

export function clearModelSession(userId) {
  MODEL_SESSIONS.delete(String(userId));
}

export const MODEL_PROMPTS = {
  link: '🔗 Envie a URL do canal <b>BGC PROMOS</b> (ex.: https://t.me/bgcpromos) ou <code>pular</code> para remover.',
  preco: '💱 Envie o formato de preço usando <code>{valor}</code>. Ex.: <code>R$ {valor}</code> ou <code>{valor}</code>.',
  emoji: '😀 Envie um ou mais pares <code>campo=emoji</code>, um por linha.\nCampos: ' + FIELD_KEYS.join(', ') + '\nEx.: <code>title=🔥</code>',
  texto: '📝 Envie um ou mais pares <code>campo=texto</code>, um por linha.\nCampos: ' + FIELD_KEYS.join(', ') + '\nEx.: <code>productLink=Link do produto</code>',
  ordem: '🔢 Envie a ordem dos campos separada por vírgula.\nCampos: ' + FIELD_KEYS.join(', ') + '\nEx.: <code>title,price,coupon,productLink,share</code>',
  opcionais: '➕ Envie os campos opcionais separados por vírgula, ou <code>nenhum</code>.\nCampos: ' + OPTIONAL_KEYS.join(', ') + '\nEx.: <code>previousPrice,pixPrice,store</code>'
};

function parsePairs(text) {
  const pairs = {};
  const errors = [];
  for (const raw of String(text ?? '').split('\n')) {
    const entry = raw.trim();
    if (!entry) continue;
    const index = entry.indexOf('=');
    if (index <= 0) {
      errors.push(`Linha inválida: ${entry}`);
      continue;
    }
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (!FIELD_KEYS.includes(key)) {
      errors.push(`Campo desconhecido: ${key}`);
      continue;
    }
    pairs[key] = value;
  }
  if (!Object.keys(pairs).length && !errors.length) {
    errors.push('Nenhum par válido informado.');
  }
  return { pairs, errors };
}

export function applyModelInput(kind, text, currentTemplate) {
  const current = mergeTemplate(currentTemplate);
  const raw = String(text ?? '').trim();
  if (/^(pular|skip|remover|limpar)$/i.test(raw)) {
    if (kind === 'link') return { ok: true, patch: { channelLink: '' } };
    return { ok: false, error: 'Informe um valor válido.' };
  }

  switch (kind) {
    case 'link': {
      if (!/^https?:\/\/\S+$/i.test(raw)) {
        return { ok: false, error: 'Envie uma URL iniciada por http:// ou https://.' };
      }
      return { ok: true, patch: { channelLink: raw } };
    }
    case 'preco': {
      if (!raw.includes('{valor}')) {
        return { ok: false, error: 'O formato precisa conter {valor}. Ex.: R$ {valor}' };
      }
      return { ok: true, patch: { priceFormat: raw } };
    }
    case 'emoji': {
      const { pairs, errors } = parsePairs(text);
      if (errors.length) return { ok: false, error: errors.join('\n') };
      return { ok: true, patch: { emojis: { ...current.emojis, ...pairs } } };
    }
    case 'texto': {
      const { pairs, errors } = parsePairs(text);
      if (errors.length) return { ok: false, error: errors.join('\n') };
      return { ok: true, patch: { labels: { ...current.labels, ...pairs } } };
    }
    case 'ordem': {
      const keys = raw.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
      const invalid = keys.filter((key) => !FIELD_KEYS.includes(key));
      if (invalid.length) return { ok: false, error: `Campos desconhecidos: ${invalid.join(', ')}` };
      const unique = [...new Set(keys)];
      if (!unique.includes('title') || !unique.includes('price')) {
        return { ok: false, error: 'A ordem precisa manter os campos title e price.' };
      }
      return { ok: true, patch: { order: unique } };
    }
    case 'opcionais': {
      if (/^(nenhum|nada|limpar|pular)$/i.test(raw)) {
        const optional = Object.fromEntries(OPTIONAL_KEYS.map((key) => [key, false]));
        return { ok: true, patch: { optional } };
      }
      const keys = raw.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
      const invalid = keys.filter((key) => !OPTIONAL_KEYS.includes(key));
      if (invalid.length) return { ok: false, error: `Campos não opcionais: ${invalid.join(', ')}` };
      const optional = Object.fromEntries(OPTIONAL_KEYS.map((key) => [key, keys.includes(key)]));
      return { ok: true, patch: { optional } };
    }
    default:
      return { ok: false, error: 'Edição desconhecida.' };
  }
}

export function registerTemplateCommand(bot, ctx) {
  bot.onText(/^\/modelo(?:@\w+)?(?:\s+(\S+))?\s*$/, async (msg, match) => {
    if (!isAdmin(ctx.config, msg.from?.id)) {
      await bot.sendMessage(msg.chat.id, 'Este comando é restrito à equipe BGC Ofertas.');
      return;
    }
    const arg = String(match?.[1] || '').toLowerCase();
    if (arg === 'ajuda' || arg === 'help') {
      await bot.sendMessage(msg.chat.id, MODEL_HELP_TEXT, { parse_mode: 'HTML' });
      return;
    }
    if (arg === 'restaurar' || arg === 'reset' || arg === 'padrao' || arg === 'padrão') {
      const template = await ctx.templateService.reset({ actorId: msg.from.id });
      clearModelSession(msg.from.id);
      const panel = templatePanel(template);
      await bot.sendMessage(msg.chat.id, `♻️ Modelo padrão restaurado.\n\n${panel.html}`, {
        parse_mode: 'HTML',
        reply_markup: panel.keyboard,
        disable_web_page_preview: true
      });
      return;
    }
    if (arg) {
      await bot.sendMessage(msg.chat.id, 'Uso: /modelo, /modelo restaurar ou /modelo ajuda.');
      return;
    }
    const template = await ctx.templateService.get();
    const panel = templatePanel(template);
    await bot.sendMessage(msg.chat.id, panel.html, {
      parse_mode: 'HTML',
      reply_markup: panel.keyboard,
      disable_web_page_preview: true
    });
  });

  bot.on('message', async (msg) => {
    try {
      if (!msg || msg.chat?.type === 'channel') return;
      if (msg.text && msg.text.startsWith('/')) return;
      const userId = msg.from?.id;
      if (!userId) return;
      if (!isAdmin(ctx.config, userId)) return;
      const session = getModelSession(userId);
      if (!session) return;

      const current = await ctx.templateService.get();
      const result = applyModelInput(session.kind, msg.text || '', current);
      if (!result.ok) {
        await bot.sendMessage(msg.chat.id, result.error, { parse_mode: 'HTML' });
        return;
      }
      const template = await ctx.templateService.update(result.patch, { actorId: userId });
      clearModelSession(userId);
      const panel = templatePanel(template);
      await bot.sendMessage(msg.chat.id, `✅ Modelo atualizado.\n\n${panel.html}`, {
        parse_mode: 'HTML',
        reply_markup: panel.keyboard,
        disable_web_page_preview: true
      });
    } catch (error) {
      logger.warn('Falha ao editar o modelo.', error.message);
      await bot.sendMessage(msg.chat.id, 'Não foi possível atualizar o modelo.').catch(() => undefined);
    }
  });
}

export function registerTemplateCallbacks(bot, ctx) {
  bot.on('callback_query', async (query) => {
    try {
      const data = String(query.data || '');
      if (!data.startsWith('modelo:')) return;
      const userId = query.from?.id;
      const chatId = query.message?.chat?.id;
      if (!userId || !chatId) return;
      if (!isAdmin(ctx.config, userId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Acesso restrito.' }).catch(() => undefined);
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => undefined);

      if (data === 'modelo:restaurar') {
        const template = await ctx.templateService.reset({ actorId: userId });
        clearModelSession(userId);
        const panel = templatePanel(template);
        await bot.sendMessage(chatId, `♻️ Modelo padrão restaurado.\n\n${panel.html}`, {
          parse_mode: 'HTML',
          reply_markup: panel.keyboard,
          disable_web_page_preview: true
        });
        return;
      }

      if (data === 'modelo:previa') {
        const template = await ctx.templateService.get();
        const panel = templatePanel(template);
        await bot.sendMessage(chatId, panel.html, {
          parse_mode: 'HTML',
          reply_markup: panel.keyboard,
          disable_web_page_preview: true
        });
        return;
      }

      if (data === 'modelo:voltar') {
        const template = await ctx.templateService.get();
        const panel = templatePanel(template);
        await bot.sendMessage(chatId, panel.html, {
          parse_mode: 'HTML',
          reply_markup: panel.keyboard,
          disable_web_page_preview: true
        });
        return;
      }

      const kind = data.slice('modelo:'.length);
      if (!MODEL_PROMPTS[kind]) return;
      setModelSession(userId, { kind });
      await bot.sendMessage(chatId, MODEL_PROMPTS[kind], { parse_mode: 'HTML' });
    } catch (error) {
      logger.warn('Falha no callback do modelo.', error.message);
    }
  });
}

export { BRAND, escapeHtml };

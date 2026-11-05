import { isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { escapeHtml } from '../services/validation-service.js';
import { DEFAULT_CATEGORIES } from '../services/offer-scorer.js';
import { describeCategories, mergeCategorySettings } from '../services/category-service.js';

export const CATEGORY_HELP_TEXT = [
  '📂 <b>Categorias da automação</b>',
  '',
  'Use /categoria para abrir o painel e:',
  '• ligar ou desligar Tecnologia, Informática, Games, Eletrônicos e Casa',
  '• incluir palavras-chave extras na busca Shopee',
  '• manter ou desativar a exclusão permanente de livros',
  '',
  '/categoria restaurar — volta ao padrão',
  '/categoria ajuda — esta mensagem',
  '',
  'Somente administradores autorizados podem alterar as categorias.'
].join('\n');

const CATEGORY_SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function getCategorySession(userId) {
  const session = CATEGORY_SESSIONS.get(String(userId));
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    CATEGORY_SESSIONS.delete(String(userId));
    return null;
  }
  return session;
}

function setCategorySession(userId, session) {
  CATEGORY_SESSIONS.set(String(userId), { ...session, createdAt: Date.now() });
}

function clearCategorySession(userId) {
  CATEGORY_SESSIONS.delete(String(userId));
}

export function categoryKeyboard(settings) {
  const resolved = mergeCategorySettings(settings);
  const rows = DEFAULT_CATEGORIES.map((item) => {
    const on = resolved.enabled.includes(item.id);
    return [
      {
        text: `${on ? '✅' : '🚫'} ${item.label}`,
        callback_data: `categoria:toggle:${item.id}`
      }
    ];
  });
  rows.push([
    {
      text: resolved.excludeBooks ? '📚 Livros: excluídos' : '📚 Livros: permitidos',
      callback_data: 'categoria:livros'
    }
  ]);
  rows.push([{ text: '➕ Palavra extra', callback_data: 'categoria:palavra' }]);
  if (resolved.extraKeywords.length) {
    rows.push(
      ...resolved.extraKeywords.slice(0, 8).map((keyword) => [
        {
          text: `🗑️ ${keyword.slice(0, 28)}`,
          callback_data: `categoria:delkw:${encodeURIComponent(keyword).slice(0, 40)}`
        }
      ])
    );
  }
  rows.push([
    { text: '♻️ Restaurar padrão', callback_data: 'categoria:restaurar' },
    { text: '⬅️ Painel', callback_data: 'admin:home' }
  ]);
  return { inline_keyboard: rows };
}

export function categoryPanel(settings) {
  return {
    html: describeCategories(settings),
    keyboard: categoryKeyboard(settings)
  };
}

async function applyToRuntime(ctx, settings) {
  if (typeof ctx.scheduler?.applyCategorySettings === 'function') {
    ctx.scheduler.applyCategorySettings(settings);
  }
}

export function registerCategoryCommand(bot, ctx) {
  bot.onText(/^\/categoria(?:@\w+)?(?:\s+(\S+))?\s*$/, async (msg, match) => {
    if (!isAdmin(ctx.config, msg.from?.id)) {
      await bot.sendMessage(msg.chat.id, 'Este comando é restrito à equipe BGC Ofertas.');
      return;
    }
    const arg = String(match?.[1] || '').toLowerCase();
    if (arg === 'ajuda' || arg === 'help') {
      await bot.sendMessage(msg.chat.id, CATEGORY_HELP_TEXT, { parse_mode: 'HTML' });
      return;
    }
    if (arg === 'restaurar' || arg === 'reset' || arg === 'padrao' || arg === 'padrão') {
      const settings = await ctx.categoryService.reset({ actorId: msg.from.id });
      await applyToRuntime(ctx, settings);
      clearCategorySession(msg.from.id);
      const panel = categoryPanel(settings);
      await bot.sendMessage(msg.chat.id, `♻️ Categorias restauradas.\n\n${panel.html}`, {
        parse_mode: 'HTML',
        reply_markup: panel.keyboard
      });
      return;
    }
    if (arg) {
      await bot.sendMessage(msg.chat.id, 'Uso: /categoria, /categoria restaurar ou /categoria ajuda.');
      return;
    }
    const settings = await ctx.categoryService.get();
    const panel = categoryPanel(settings);
    await bot.sendMessage(msg.chat.id, panel.html, {
      parse_mode: 'HTML',
      reply_markup: panel.keyboard
    });
  });

  bot.on('message', async (msg) => {
    try {
      if (!msg || msg.chat?.type === 'channel') return;
      if (msg.text && msg.text.startsWith('/')) return;
      const userId = msg.from?.id;
      if (!userId || !isAdmin(ctx.config, userId)) return;
      const session = getCategorySession(userId);
      if (!session || session.kind !== 'palavra') return;

      const result = await ctx.categoryService.addKeyword(msg.text || '', { actorId: userId });
      clearCategorySession(userId);
      if (!result.ok) {
        await bot.sendMessage(msg.chat.id, result.error);
        return;
      }
      await applyToRuntime(ctx, result.settings);
      const panel = categoryPanel(result.settings);
      await bot.sendMessage(msg.chat.id, `✅ Palavra-chave adicionada.\n\n${panel.html}`, {
        parse_mode: 'HTML',
        reply_markup: panel.keyboard
      });
    } catch (error) {
      logger.warn('Falha ao editar categorias.', error.message);
      await bot.sendMessage(msg.chat.id, 'Não foi possível atualizar as categorias.').catch(() => undefined);
    }
  });
}

export function registerCategoryCallbacks(bot, ctx) {
  bot.on('callback_query', async (query) => {
    try {
      const data = String(query.data || '');
      if (!data.startsWith('categoria:')) return;
      const userId = query.from?.id;
      const chatId = query.message?.chat?.id;
      if (!userId || !chatId) return;
      if (!isAdmin(ctx.config, userId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Acesso restrito.' }).catch(() => undefined);
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => undefined);

      if (data === 'categoria:voltar') {
        const settings = await ctx.categoryService.get();
        const panel = categoryPanel(settings);
        await bot.sendMessage(chatId, panel.html, { parse_mode: 'HTML', reply_markup: panel.keyboard });
        return;
      }

      if (data === 'categoria:restaurar') {
        const settings = await ctx.categoryService.reset({ actorId: userId });
        await applyToRuntime(ctx, settings);
        clearCategorySession(userId);
        const panel = categoryPanel(settings);
        await bot.sendMessage(chatId, `♻️ Categorias restauradas.\n\n${panel.html}`, {
          parse_mode: 'HTML',
          reply_markup: panel.keyboard
        });
        return;
      }

      if (data === 'categoria:livros') {
        const current = await ctx.categoryService.get();
        const result = await ctx.categoryService.setExcludeBooks(!current.excludeBooks, { actorId: userId });
        await applyToRuntime(ctx, result.settings);
        const panel = categoryPanel(result.settings);
        await bot.sendMessage(chatId, panel.html, { parse_mode: 'HTML', reply_markup: panel.keyboard });
        return;
      }

      if (data === 'categoria:palavra') {
        setCategorySession(userId, { kind: 'palavra' });
        await bot.sendMessage(
          chatId,
          '➕ Envie a palavra-chave extra para a busca Shopee.\nExemplo: <code>air fryer</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (data.startsWith('categoria:toggle:')) {
        const id = data.slice('categoria:toggle:'.length);
        const result = await ctx.categoryService.toggle(id, { actorId: userId });
        if (!result.ok) {
          await bot.sendMessage(chatId, result.error);
          return;
        }
        await applyToRuntime(ctx, result.settings);
        const panel = categoryPanel(result.settings);
        await bot.sendMessage(chatId, panel.html, { parse_mode: 'HTML', reply_markup: panel.keyboard });
        return;
      }

      if (data.startsWith('categoria:delkw:')) {
        const encoded = data.slice('categoria:delkw:'.length);
        let keyword = encoded;
        try {
          keyword = decodeURIComponent(encoded);
        } catch {
          keyword = encoded;
        }
        const result = await ctx.categoryService.removeKeyword(keyword, { actorId: userId });
        await applyToRuntime(ctx, result.settings);
        const panel = categoryPanel(result.settings);
        await bot.sendMessage(chatId, `🗑️ Removido: ${escapeHtml(keyword)}\n\n${panel.html}`, {
          parse_mode: 'HTML',
          reply_markup: panel.keyboard
        });
      }
    } catch (error) {
      logger.warn('Falha no callback de categorias.', error.message);
    }
  });
}

export function hasCategorySession(userId) {
  return Boolean(getCategorySession(userId));
}

export { CATEGORY_SESSIONS };

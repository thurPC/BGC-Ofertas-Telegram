import { isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { escapeHtml } from '../services/validation-service.js';
import { DEFAULT_CATEGORIES } from '../services/offer-scorer.js';
import { describeCategories, mergeCategorySettings } from '../services/category-service.js';

export const CATEGORY_HELP_TEXT = [
  '<b>Categorias da automacao</b>',
  '',
  'Use /categoria para abrir o painel e:',
  '- adicionar um item extra de busca',
  '- ativar ou desativar categorias padrao e itens extras',
  '- remover um item extra',
  '- manter ou desativar a exclusao permanente de livros',
  '',
  '/categoria restaurar — volta ao padrao',
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

function extraToken(index) {
  return String(index);
}

export function categoryKeyboard(settings) {
  const resolved = mergeCategorySettings(settings);
  const rows = [];
  for (const item of DEFAULT_CATEGORIES) {
    const on = resolved.enabled.includes(item.id);
    rows.push([{ text: `${on ? 'ON' : 'OFF'} ${item.label}`, callback_data: `categoria:noop:${item.id}` }]);
    rows.push([
      { text: 'Ativar', callback_data: `categoria:on:${item.id}` },
      { text: 'Desativar', callback_data: `categoria:off:${item.id}` }
    ]);
  }
  rows.push([
    {
      text: resolved.excludeBooks ? 'Livros: excluidos' : 'Livros: permitidos',
      callback_data: 'categoria:livros'
    }
  ]);
  rows.push([{ text: 'Adicionar item', callback_data: 'categoria:add' }]);
  resolved.extras.slice(0, 8).forEach((item, index) => {
    const token = extraToken(index);
    rows.push([
      {
        text: `${item.enabled ? 'ON' : 'OFF'} ${item.keyword.slice(0, 28)}`,
        callback_data: `categoria:xnoop:${token}`
      }
    ]);
    rows.push([
      { text: 'Ativar', callback_data: `categoria:xon:${token}` },
      { text: 'Desativar', callback_data: `categoria:xoff:${token}` },
      { text: 'Remover', callback_data: `categoria:xdel:${token}` }
    ]);
  });
  rows.push([
    { text: 'Restaurar padrao', callback_data: 'categoria:restaurar' },
    { text: 'Painel', callback_data: 'admin:home' }
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

function extraFromToken(settings, token) {
  const index = Number.parseInt(String(token), 10);
  if (!Number.isInteger(index) || index < 0) return null;
  return settings.extras[index] || null;
}

export function registerCategoryCommand(bot, ctx) {
  bot.onText(/^\/categoria(?:@\w+)?(?:\s+(\S+))?\s*$/, async (msg, match) => {
    if (!isAdmin(ctx.config, msg.from?.id)) {
      await bot.sendMessage(msg.chat.id, 'Este comando e restrito a equipe BGC Ofertas.');
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
      await bot.sendMessage(msg.chat.id, `Categorias restauradas.\n\n${panel.html}`, {
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
      await bot.sendMessage(msg.chat.id, `Item extra adicionado.\n\n${panel.html}`, {
        parse_mode: 'HTML',
        reply_markup: panel.keyboard
      });
    } catch (error) {
      logger.warn('Falha ao editar categorias.', error.message);
      await bot.sendMessage(msg.chat.id, 'Nao foi possivel atualizar as categorias.').catch(() => undefined);
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
        await bot.sendMessage(chatId, `Categorias restauradas.\n\n${panel.html}`, {
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

      if (data === 'categoria:add' || data === 'categoria:palavra') {
        setCategorySession(userId, { kind: 'palavra' });
        await bot.sendMessage(
          chatId,
          'Envie a palavra-chave extra para a busca Shopee.\nExemplo: <code>air fryer</code>',
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (data.startsWith('categoria:noop:') || data.startsWith('categoria:xnoop:')) return;

      if (data.startsWith('categoria:on:')) {
        const id = data.slice('categoria:on:'.length);
        const result = await ctx.categoryService.activate(id, { actorId: userId });
        if (!result.ok) {
          await bot.sendMessage(chatId, result.error);
          return;
        }
        await applyToRuntime(ctx, result.settings);
        const panel = categoryPanel(result.settings);
        await bot.sendMessage(chatId, panel.html, { parse_mode: 'HTML', reply_markup: panel.keyboard });
        return;
      }

      if (data.startsWith('categoria:off:')) {
        const id = data.slice('categoria:off:'.length);
        const result = await ctx.categoryService.deactivate(id, { actorId: userId });
        if (!result.ok) {
          await bot.sendMessage(chatId, result.error);
          return;
        }
        await applyToRuntime(ctx, result.settings);
        const panel = categoryPanel(result.settings);
        await bot.sendMessage(chatId, panel.html, { parse_mode: 'HTML', reply_markup: panel.keyboard });
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

      const extraAction = /^(categoria:x(?:on|off|del)):(\d+)$/.exec(data);
      if (extraAction) {
        const current = await ctx.categoryService.get();
        const extra = extraFromToken(current, extraAction[2]);
        if (!extra) {
          await bot.sendMessage(chatId, 'Item extra nao encontrado.');
          return;
        }
        let result;
        if (extraAction[1] === 'categoria:xon') result = await ctx.categoryService.activate(extra.keyword, { actorId: userId });
        else if (extraAction[1] === 'categoria:xoff') result = await ctx.categoryService.deactivate(extra.keyword, { actorId: userId });
        else result = await ctx.categoryService.removeKeyword(extra.keyword, { actorId: userId });
        if (!result.ok) {
          await bot.sendMessage(chatId, result.error);
          return;
        }
        await applyToRuntime(ctx, result.settings);
        const panel = categoryPanel(result.settings);
        const prefix = extraAction[1] === 'categoria:xdel' ? `Removido: ${escapeHtml(extra.keyword)}\n\n` : '';
        await bot.sendMessage(chatId, `${prefix}${panel.html}`, { parse_mode: 'HTML', reply_markup: panel.keyboard });
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
        await bot.sendMessage(chatId, `Removido: ${escapeHtml(keyword)}\n\n${panel.html}`, {
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

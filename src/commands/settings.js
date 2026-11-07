import { isAdmin } from '../config.js';
import { logger } from '../logger.js';
import {
  describeOperatingHours,
  formatCategoryList,
  formatHour,
  parseHourInput
} from '../services/settings-service.js';
import { categoryPanel as automationCategoryPanel } from './category.js';
import { escapeHtml } from '../services/validation-service.js';

const SETTINGS_SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

export function getSettingsSession(userId) {
  const session = SETTINGS_SESSIONS.get(String(userId));
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    SETTINGS_SESSIONS.delete(String(userId));
    return null;
  }
  return session;
}

export function setSettingsSession(userId, session) {
  SETTINGS_SESSIONS.set(String(userId), { ...session, createdAt: Date.now() });
}

export function clearSettingsSession(userId) {
  SETTINGS_SESSIONS.delete(String(userId));
}

export const CATEGORY_HELP = [
  '🏷️ <b>Painel de categorias</b>',
  '',
  'Somente ofertas das categorias <b>ativas</b> são buscadas e publicadas.',
  'Itens extras entram como palavras-chave de busca e também liberam a publicação.',
  'Opções: adicionar, ativar, desativar e remover item.'
].join('\n');

export const HOURS_HELP = [
  '⏰ <b>Horário de operação</b>',
  '',
  'Defina o intervalo em que o bot pode publicar automaticamente.',
  'Use o formato 24h, somente a hora, sem minutos. Ex.: 8 e 22.',
  'Valores aceitos: 0 a 23. Também vale 8h ou 08.',
  'Fora desse intervalo a publicação automática não roda.'
].join('\n');

export function categoryKeyboard(categories = []) {
  const rows = [
    [{ text: '➕ Adicionar categoria', callback_data: 'cat:add' }]
  ];
  for (const item of categories.slice(0, 16)) {
    const label = item.name.length > 22 ? `${item.name.slice(0, 21)}…` : item.name;
    rows.push([
      {
        text: `${item.enabled ? '✅' : '⏸️'} ${label}`,
        callback_data: `cat:item:${item.id}`
      }
    ]);
  }
  rows.push([{ text: '⬅️ Painel', callback_data: 'admin:home' }]);
  return { inline_keyboard: rows };
}

export function categoryItemKeyboard(category) {
  const toggle = category.enabled
    ? { text: '⏸️ Desativar', callback_data: `cat:off:${category.id}` }
    : { text: '▶️ Ativar', callback_data: `cat:on:${category.id}` };
  return {
    inline_keyboard: [
      [toggle],
      [{ text: '🗑️ Remover item', callback_data: `cat:del:${category.id}` }],
      [{ text: '⬅️ Categorias', callback_data: 'cat:home' }]
    ]
  };
}

export function confirmCategoryDeleteKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirmar remoção', callback_data: `cat:delok:${id}` },
        { text: '❌ Cancelar', callback_data: `cat:item:${id}` }
      ]
    ]
  };
}

export function hoursKeyboard(hours) {
  const alwaysMark = hours?.mode !== 'range' ? '● ' : '';
  const rangeMark = hours?.mode === 'range' ? '● ' : '';
  return {
    inline_keyboard: [
      [{ text: `${alwaysMark}24 horas`, callback_data: 'hours:always' }],
      [{ text: `${rangeMark}Definir intervalo`, callback_data: 'hours:range' }],
      [
        { text: `Início ${formatHour(hours?.startHour)}`, callback_data: 'hours:start' },
        { text: `Fim ${formatHour(hours?.endHour)}`, callback_data: 'hours:end' }
      ],
      [{ text: '⬅️ Painel', callback_data: 'admin:home' }]
    ]
  };
}

export function categoryPanel(categories) {
  return {
    html: `${CATEGORY_HELP}\n\n<b>Itens cadastrados</b>\n${formatCategoryList(categories)}`,
    keyboard: categoryKeyboard(categories)
  };
}

export function categoryItemPanel(category) {
  const state = category.enabled ? 'ativa' : 'inativa';
  return {
    html: [
      '🏷️ <b>Categoria</b>',
      '',
      `<b>${escapeHtml(category.name)}</b>`,
      `Estado: ${state}`,
      '',
        'Ativa: entra na busca e libera a publicação.',
        'Inativa: permanece na lista, sem filtrar nem publicar.',
        'Remover item: apaga a categoria da lista.'
    ].join('\n'),
    keyboard: categoryItemKeyboard(category)
  };
}

export function hoursPanel(hours) {
  return {
    html: `${HOURS_HELP}\n\n<b>Atual</b>\n${escapeHtml(describeOperatingHours(hours))}`,
    keyboard: hoursKeyboard(hours)
  };
}

export function categoriesNote(categories = []) {
  if (!categories.length) return 'Categorias extras: nenhuma cadastrada.';
  const active = categories.filter((item) => item.enabled).length;
  return `Categorias extras: ${active} ativa(s) de ${categories.length}.`;
}

async function applyCategoryRuntime(ctx) {
  if (typeof ctx.scheduler?.applyCategorySettings !== 'function') return;
  if (ctx.categoryService?.get) {
    ctx.scheduler.applyCategorySettings(await ctx.categoryService.get());
    return;
  }
  if (ctx.settingsService?.categorySettings) {
    ctx.scheduler.applyCategorySettings(await ctx.settingsService.categorySettings());
  }
}

async function sendCategoryHome(bot, ctx, chatId, prefix = '') {
  if (ctx.categoryService?.get) {
    const settings = await ctx.categoryService.get();
    const panel = automationCategoryPanel(settings);
    const html = prefix ? `${prefix}\n\n${panel.html}` : panel.html;
    await bot.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      reply_markup: panel.keyboard
    });
    return;
  }
  const categories = await ctx.settingsService.listCategories();
  const panel = categoryPanel(categories);
  const html = prefix ? `${prefix}\n\n${panel.html}` : panel.html;
  await bot.sendMessage(chatId, html, {
    parse_mode: 'HTML',
    reply_markup: panel.keyboard
  });
}

async function sendHoursHome(bot, ctx, chatId, prefix = '') {
  const settings = await ctx.settingsService.get();
  const panel = hoursPanel(settings.operatingHours);
  const html = prefix ? `${prefix}\n\n${panel.html}` : panel.html;
  await bot.sendMessage(chatId, html, {
    parse_mode: 'HTML',
    reply_markup: panel.keyboard
  });
}

function safeAnswer(bot, query, text) {
  return bot.answerCallbackQuery(query.id, text ? { text: text.slice(0, 180) } : {}).catch(() => undefined);
}

export function registerSettingsCommand(bot, ctx) {
  bot.onText(/^\/categorias(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (!isAdmin(ctx.config, msg.from?.id)) {
      await bot.sendMessage(msg.chat.id, 'Este comando é restrito à equipe BGC Ofertas.');
      return;
    }
    await sendCategoryHome(bot, ctx, msg.chat.id);
  });

  bot.onText(/^\/horario(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (!isAdmin(ctx.config, msg.from?.id)) {
      await bot.sendMessage(msg.chat.id, 'Este comando é restrito à equipe BGC Ofertas.');
      return;
    }
    await sendHoursHome(bot, ctx, msg.chat.id);
  });

  bot.on('message', async (msg) => {
    try {
      if (!msg || msg.chat?.type === 'channel') return;
      if (msg.text && msg.text.startsWith('/')) return;
      const userId = msg.from?.id;
      if (!userId) return;
      if (!isAdmin(ctx.config, userId)) return;
      const session = getSettingsSession(userId);
      if (!session) return;

      if (session.kind === 'category-add') {
        const result = await ctx.settingsService.addCategory(msg.text || '', { actorId: userId });
        if (!result.ok) {
          await bot.sendMessage(msg.chat.id, result.error);
          return;
        }
        clearSettingsSession(userId);
        await applyCategoryRuntime(ctx);
        await sendCategoryHome(bot, ctx, msg.chat.id, `Categoria <b>${escapeHtml(result.category.name)}</b> adicionada e ativa.`);
        return;
      }

      if (session.kind === 'hours-start' || session.kind === 'hours-end') {
        const parsed = parseHourInput(msg.text || '');
        if (!parsed.ok) {
          await bot.sendMessage(msg.chat.id, parsed.error);
          return;
        }
        const field = session.kind === 'hours-start' ? 'startHour' : 'endHour';
        const current = await ctx.settingsService.get();
        const result = await ctx.settingsService.setOperatingHours(
          {
            mode: 'range',
            startHour: current.operatingHours.startHour,
            endHour: current.operatingHours.endHour,
            [field]: parsed.hour
          },
          { actorId: userId }
        );
        clearSettingsSession(userId);
        await sendHoursHome(bot, ctx, msg.chat.id, describeOperatingHours(result.operatingHours));
      }
    } catch (error) {
      logger.warn('Falha ao processar configuração.', error.message);
      await bot.sendMessage(msg.chat.id, 'Não foi possível salvar a configuração.').catch(() => undefined);
    }
  });
}

export function registerSettingsCallbacks(bot, ctx) {
  bot.on('callback_query', async (query) => {
    try {
      const data = String(query.data || '');
      if (!data.startsWith('cat:') && !data.startsWith('hours:')) return;
      const userId = query.from?.id;
      const chatId = query.message?.chat?.id;
      if (!userId || !chatId) return;
      if (!isAdmin(ctx.config, userId)) {
        await safeAnswer(bot, query, 'Acesso restrito.');
        return;
      }

      if (data === 'cat:home') {
        await safeAnswer(bot, query);
        await sendCategoryHome(bot, ctx, chatId);
        return;
      }

      if (data === 'cat:add') {
        setSettingsSession(userId, { kind: 'category-add' });
        await safeAnswer(bot, query);
        await bot.sendMessage(
          chatId,
          '➕ Envie o nome da categoria para adicionar.\nEla entra <b>ativa</b> e passa a filtrar produtos. Use /cancelar para abortar.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (data.startsWith('cat:item:')) {
        const id = data.slice('cat:item:'.length);
        const categories = await ctx.settingsService.listCategories();
        const category = categories.find((item) => item.id === id);
        if (!category) {
          await safeAnswer(bot, query, 'Categoria não encontrada.');
          return;
        }
        await safeAnswer(bot, query);
        const panel = categoryItemPanel(category);
        await bot.sendMessage(chatId, panel.html, {
          parse_mode: 'HTML',
          reply_markup: panel.keyboard
        });
        return;
      }

      if (data.startsWith('cat:on:') || data.startsWith('cat:off:')) {
        const enable = data.startsWith('cat:on:');
        const id = data.slice(enable ? 'cat:on:'.length : 'cat:off:'.length);
        const result = await ctx.settingsService.setCategoryEnabled(id, enable, { actorId: userId });
        await safeAnswer(bot, query, result.ok ? (enable ? 'Ativada.' : 'Desativada.') : result.error);
        if (!result.ok) {
          await bot.sendMessage(chatId, result.error);
          return;
        }
        await applyCategoryRuntime(ctx);
        const panel = categoryItemPanel(result.category);
        await bot.sendMessage(chatId, panel.html, {
          parse_mode: 'HTML',
          reply_markup: panel.keyboard
        });
        return;
      }

      if (data.startsWith('cat:del:') && !data.startsWith('cat:delok:')) {
        const id = data.slice('cat:del:'.length);
        await safeAnswer(bot, query);
        await bot.sendMessage(chatId, 'Confirma a remoção desta categoria? Esta ação não pode ser desfeita.', {
          reply_markup: confirmCategoryDeleteKeyboard(id)
        });
        return;
      }

      if (data.startsWith('cat:delok:')) {
        const id = data.slice('cat:delok:'.length);
        const result = await ctx.settingsService.removeCategory(id, { actorId: userId });
        await safeAnswer(bot, query, result.ok ? 'Removida.' : result.error);
        if (!result.ok) {
          await bot.sendMessage(chatId, result.error);
          return;
        }
        await applyCategoryRuntime(ctx);
        await sendCategoryHome(
          bot,
          ctx,
          chatId,
          `Item <b>${escapeHtml(result.category.name)}</b> removido.`
        );
        return;
      }

      if (data === 'hours:home' || data === 'hours:voltar') {
        await safeAnswer(bot, query);
        await sendHoursHome(bot, ctx, chatId);
        return;
      }

      if (data === 'hours:always') {
        const result = await ctx.settingsService.setAlwaysOn({ actorId: userId });
        await safeAnswer(bot, query, '24 horas.');
        await sendHoursHome(bot, ctx, chatId, describeOperatingHours(result.operatingHours));
        return;
      }

      if (data === 'hours:range') {
        const current = await ctx.settingsService.get();
        const result = await ctx.settingsService.setOperatingHours(
          {
            mode: 'range',
            startHour: current.operatingHours.startHour,
            endHour: current.operatingHours.endHour
          },
          { actorId: userId }
        );
        await safeAnswer(bot, query, 'Intervalo ativo.');
        await sendHoursHome(bot, ctx, chatId, describeOperatingHours(result.operatingHours));
        return;
      }

      if (data === 'hours:start' || data === 'hours:end') {
        const kind = data === 'hours:start' ? 'hours-start' : 'hours-end';
        setSettingsSession(userId, { kind });
        await safeAnswer(bot, query);
        const label = kind === 'hours-start' ? 'início' : 'fim';
        await bot.sendMessage(
          chatId,
          `⏰ Envie a hora de <b>${label}</b> no formato 24h, sem minutos.\nExemplos: <code>8</code>, <code>08</code>, <code>8h</code> ou <code>22</code>.`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (error) {
      logger.warn('Falha no callback de configuração.', error.message);
      await safeAnswer(bot, query, 'Não foi possível concluir a ação.');
    }
  });
}

export { sendCategoryHome, sendHoursHome };

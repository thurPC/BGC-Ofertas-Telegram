import { isAdmin } from '../config.js';
import { logger } from '../logger.js';
import { describeSchedule, formatScheduleRange, mergeScheduleSettings } from '../services/schedule-service.js';

export const SCHEDULE_HELP_TEXT = [
  '<b>Horario de operacao</b>',
  '',
  'Use /horario para definir quando a automacao consulta e publica ofertas.',
  'Formato 24 horas, sem minutos.',
  '',
  'Exemplos:',
  '/horario 08-22',
  '/horario 9 18',
  '/horario 24h',
  '',
  '/horario restaurar — volta ao padrao (24h ou OFFER_ALLOWED_HOURS)',
  '/horario ajuda — esta mensagem',
  '',
  'Somente administradores autorizados podem alterar o horario.'
].join('\n');

const SCHEDULE_SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function getScheduleSession(userId) {
  const session = SCHEDULE_SESSIONS.get(String(userId));
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    SCHEDULE_SESSIONS.delete(String(userId));
    return null;
  }
  return session;
}

function setScheduleSession(userId, session) {
  SCHEDULE_SESSIONS.set(String(userId), { ...session, createdAt: Date.now() });
}

function clearScheduleSession(userId) {
  SCHEDULE_SESSIONS.delete(String(userId));
}

export function scheduleKeyboard(settings) {
  const resolved = mergeScheduleSettings(settings);
  return {
    inline_keyboard: [
      [
        { text: '08-22', callback_data: 'horario:set:08-22' },
        { text: '09-18', callback_data: 'horario:set:09-18' }
      ],
      [
        { text: '10-22', callback_data: 'horario:set:10-22' },
        { text: '24h', callback_data: 'horario:set:24h' }
      ],
      [{ text: 'Definir horario', callback_data: 'horario:custom' }],
      [
        { text: 'Restaurar padrao', callback_data: 'horario:restaurar' },
        { text: 'Painel', callback_data: 'admin:home' }
      ]
    ]
  };
}

export function schedulePanel(settings) {
  return {
    html: describeSchedule(settings),
    keyboard: scheduleKeyboard(settings)
  };
}

async function applyToRuntime(ctx, settings) {
  if (typeof ctx.scheduler?.applyScheduleSettings === 'function') {
    ctx.scheduler.applyScheduleSettings(settings);
  }
}

export function registerScheduleCommand(bot, ctx) {
  bot.onText(/^\/horario(?:@\w+)?(?:\s+(.+))?\s*$/, async (msg, match) => {
    if (!isAdmin(ctx.config, msg.from?.id)) {
      await bot.sendMessage(msg.chat.id, 'Este comando e restrito a equipe BGC Ofertas.');
      return;
    }
    const arg = String(match?.[1] || String(msg.text || '').replace(/^\/horario(?:@\w+)?\s*/i, '')).trim();
    const lower = arg.toLowerCase();
    if (lower === 'ajuda' || lower === 'help') {
      await bot.sendMessage(msg.chat.id, SCHEDULE_HELP_TEXT, { parse_mode: 'HTML' });
      return;
    }
    if (lower === 'restaurar' || lower === 'reset' || lower === 'padrao' || lower === 'padrão') {
      const settings = await ctx.scheduleService.reset({ actorId: msg.from.id });
      await applyToRuntime(ctx, settings);
      clearScheduleSession(msg.from.id);
      const panel = schedulePanel(settings);
      await bot.sendMessage(msg.chat.id, `Horario restaurado (${formatScheduleRange(settings)}).\n\n${panel.html}`, {
        parse_mode: 'HTML',
        reply_markup: panel.keyboard
      });
      return;
    }
    if (arg) {
      const result = await ctx.scheduleService.setFromInput(arg, { actorId: msg.from.id });
      if (!result.ok) {
        await bot.sendMessage(msg.chat.id, result.error);
        return;
      }
      await applyToRuntime(ctx, result.settings);
      const panel = schedulePanel(result.settings);
      await bot.sendMessage(msg.chat.id, `Horario atualizado (${formatScheduleRange(result.settings)}).\n\n${panel.html}`, {
        parse_mode: 'HTML',
        reply_markup: panel.keyboard
      });
      return;
    }
    const settings = await ctx.scheduleService.get();
    const panel = schedulePanel(settings);
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
      const session = getScheduleSession(userId);
      if (!session || session.kind !== 'horario') return;

      const result = await ctx.scheduleService.setFromInput(msg.text || '', { actorId: userId });
      clearScheduleSession(userId);
      if (!result.ok) {
        await bot.sendMessage(msg.chat.id, result.error);
        return;
      }
      await applyToRuntime(ctx, result.settings);
      const panel = schedulePanel(result.settings);
      await bot.sendMessage(msg.chat.id, `Horario atualizado (${formatScheduleRange(result.settings)}).\n\n${panel.html}`, {
        parse_mode: 'HTML',
        reply_markup: panel.keyboard
      });
    } catch (error) {
      logger.warn('Falha ao editar horario.', error.message);
      await bot.sendMessage(msg.chat.id, 'Nao foi possivel atualizar o horario.').catch(() => undefined);
    }
  });
}

export function registerScheduleCallbacks(bot, ctx) {
  bot.on('callback_query', async (query) => {
    try {
      const data = String(query.data || '');
      if (!data.startsWith('horario:')) return;
      const userId = query.from?.id;
      const chatId = query.message?.chat?.id;
      if (!userId || !chatId) return;
      if (!isAdmin(ctx.config, userId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Acesso restrito.' }).catch(() => undefined);
        return;
      }
      await bot.answerCallbackQuery(query.id).catch(() => undefined);

      if (data === 'horario:voltar') {
        const settings = await ctx.scheduleService.get();
        const panel = schedulePanel(settings);
        await bot.sendMessage(chatId, panel.html, { parse_mode: 'HTML', reply_markup: panel.keyboard });
        return;
      }

      if (data === 'horario:restaurar') {
        const settings = await ctx.scheduleService.reset({ actorId: userId });
        await applyToRuntime(ctx, settings);
        clearScheduleSession(userId);
        const panel = schedulePanel(settings);
        await bot.sendMessage(chatId, `Horario restaurado (${formatScheduleRange(settings)}).\n\n${panel.html}`, {
          parse_mode: 'HTML',
          reply_markup: panel.keyboard
        });
        return;
      }

      if (data === 'horario:custom') {
        setScheduleSession(userId, { kind: 'horario' });
        await bot.sendMessage(
          chatId,
          'Envie o horario no formato 24h, sem minutos.\nExemplos: <code>08-22</code>, <code>9 18</code> ou <code>24h</code>.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (data.startsWith('horario:set:')) {
        const value = data.slice('horario:set:'.length);
        const result = await ctx.scheduleService.setFromInput(value, { actorId: userId });
        if (!result.ok) {
          await bot.sendMessage(chatId, result.error);
          return;
        }
        await applyToRuntime(ctx, result.settings);
        const panel = schedulePanel(result.settings);
        await bot.sendMessage(chatId, `Horario atualizado (${formatScheduleRange(result.settings)}).\n\n${panel.html}`, {
          parse_mode: 'HTML',
          reply_markup: panel.keyboard
        });
      }
    } catch (error) {
      logger.warn('Falha no callback de horario.', error.message);
    }
  });
}

export function hasScheduleSession(userId) {
  return Boolean(getScheduleSession(userId));
}

export { SCHEDULE_SESSIONS };

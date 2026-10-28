import { isAdmin } from '../config.js';
import {
  ADMIN_HELP_TEXT,
  adminKeyboard,
  formatOfferList,
  formatStatus,
  offerActionKeyboard
} from '../commands/admin.js';
import { applyWizardInput, createWizardState, previewPayload, wizardPrompt } from './wizard.js';
import { logger } from '../logger.js';

const SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

export function getSession(userId) {
  const session = SESSIONS.get(String(userId));
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    SESSIONS.delete(String(userId));
    return null;
  }
  return session;
}

export function setSession(userId, session) {
  SESSIONS.set(String(userId), session);
}

export function clearSession(userId) {
  SESSIONS.delete(String(userId));
}

export function denyAdmin(bot, chatId) {
  return bot.sendMessage(chatId, 'Este comando é restrito à equipe BGC Ofertas.');
}

export function registerMessageHandler(bot, ctx) {
  bot.on('message', async (msg) => {
    try {
      if (!msg || msg.chat?.type === 'channel') return;
      if (msg.text && msg.text.startsWith('/')) return;
      const userId = msg.from?.id;
      if (!userId) return;
      if (!isAdmin(ctx.config, userId)) return;

      const session = getSession(userId);
      if (!session) return;

      const result = applyWizardInput(session, msg.text || '');
      if (!result.ok) {
        await bot.sendMessage(msg.chat.id, result.error || 'Valor inválido. Tente novamente.');
        return;
      }
      setSession(userId, session);
      if (result.done) {
        const preview = previewPayload(session);
        await bot.sendMessage(msg.chat.id, preview.html, {
          parse_mode: 'HTML',
          reply_markup: preview.keyboard,
          disable_web_page_preview: true
        });
        return;
      }
      await bot.sendMessage(msg.chat.id, wizardPrompt(session.step), { parse_mode: 'HTML' });
    } catch (error) {
      logger.warn('Falha no handler de mensagens.', error.message);
      await bot.sendMessage(msg.chat.id, 'Não foi possível processar a mensagem.').catch(() => undefined);
    }
  });

  bot.onText(/^\/admin(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (!isAdmin(ctx.config, msg.from?.id)) return denyAdmin(bot, msg.chat.id);
    await bot.sendMessage(msg.chat.id, '🛠️ <b>Painel administrativo BGC Ofertas</b>', {
      parse_mode: 'HTML',
      reply_markup: adminKeyboard()
    });
  });

  bot.onText(/^\/ajuda_admin(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (!isAdmin(ctx.config, msg.from?.id)) return denyAdmin(bot, msg.chat.id);
    await bot.sendMessage(msg.chat.id, ADMIN_HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/novaoferta(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (!isAdmin(ctx.config, msg.from?.id)) return denyAdmin(bot, msg.chat.id);
    const session = createWizardState(msg.from.id);
    setSession(msg.from.id, session);
    await bot.sendMessage(
      msg.chat.id,
      `🆕 Cadastro guiado iniciado.\nUse /cancelar para abortar.\n\n${wizardPrompt('name')}`,
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/^\/cancelar(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (!isAdmin(ctx.config, msg.from?.id)) return denyAdmin(bot, msg.chat.id);
    if (!getSession(msg.from.id)) {
      await bot.sendMessage(msg.chat.id, 'Não há cadastro em andamento.');
      return;
    }
    clearSession(msg.from.id);
    await bot.sendMessage(msg.chat.id, 'Cadastro cancelado.');
  });

  bot.onText(/^\/ofertas(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (!isAdmin(ctx.config, msg.from?.id)) return denyAdmin(bot, msg.chat.id);
    const offers = await ctx.offerService.list();
    await bot.sendMessage(msg.chat.id, formatOfferList(offers), { parse_mode: 'HTML' });
  });

  bot.onText(/^\/status(?:@\w+)?(?:\s|$)/, async (msg) => {
    if (!isAdmin(ctx.config, msg.from?.id)) return denyAdmin(bot, msg.chat.id);
    const stats = await ctx.offerService.operationalStatus();
    const scheduler = ctx.scheduler?.describe?.() || {};
    await bot.sendMessage(
      msg.chat.id,
      formatStatus(stats, {
        nodeEnv: ctx.config.nodeEnv,
        hasChannel: Boolean(ctx.config.channelId),
        adminCount: ctx.config.adminIds.length,
        autoNote: scheduler.note
      }),
      { parse_mode: 'HTML' }
    );
  });

  bot.onText(/^\/publicar(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAdmin(ctx.config, msg.from?.id)) return denyAdmin(bot, msg.chat.id);
    const id = String(match?.[1] || '').trim();
    if (!id) {
      await bot.sendMessage(msg.chat.id, 'Informe o ID da oferta. Exemplo: /publicar a1b2c3d4e5f6');
      return;
    }
    const offer = await ctx.offerService.getById(id);
    if (!offer) {
      await bot.sendMessage(msg.chat.id, 'Oferta não encontrada.');
      return;
    }
    const result = await ctx.publishingService.publish(offer, { actorId: msg.from.id });
    if (!result.ok) {
      await bot.sendMessage(msg.chat.id, result.error);
      return;
    }
    await bot.sendMessage(msg.chat.id, 'Oferta publicada no canal.');
  });

  bot.onText(/^\/ver(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAdmin(ctx.config, msg.from?.id)) return denyAdmin(bot, msg.chat.id);
    const id = String(match?.[1] || '').trim();
    if (!id) return;
    const offer = await ctx.offerService.getById(id);
    if (!offer) {
      await bot.sendMessage(msg.chat.id, 'Oferta não encontrada.');
      return;
    }
    await bot.sendMessage(msg.chat.id, formatOfferList([offer]), {
      parse_mode: 'HTML',
      reply_markup: offerActionKeyboard(offer)
    });
  });
}

export { SESSIONS };

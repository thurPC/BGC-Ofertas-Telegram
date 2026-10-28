import { isAdmin } from '../config.js';
import {
  ADMIN_HELP_TEXT,
  adminKeyboard,
  confirmDeleteKeyboard,
  formatOfferList,
  formatStatus,
  offerActionKeyboard,
  offerListKeyboard
} from '../commands/admin.js';
import { formatOfferPreview } from '../formatters/offer-message.js';
import {
  clearSession,
  getSession,
  setSession
} from './message-handler.js';
import {
  createWizardState,
  EDIT_FIELD_KEYBOARD,
  previewPayload,
  wizardPrompt
} from './wizard.js';
import { logger } from '../logger.js';

function safeAnswer(bot, query, text) {
  return bot.answerCallbackQuery(query.id, text ? { text: text.slice(0, 180) } : {}).catch(() => undefined);
}

export function registerCallbackHandler(bot, ctx) {
  bot.on('callback_query', async (query) => {
    try {
      const userId = query.from?.id;
      const chatId = query.message?.chat?.id;
      const data = String(query.data || '');
      if (!userId || !chatId) return;

      if (!isAdmin(ctx.config, userId)) {
        await safeAnswer(bot, query, 'Acesso restrito.');
        return;
      }

      if (data === 'admin:home') {
        await safeAnswer(bot, query);
        await bot.sendMessage(chatId, '🛠️ <b>Painel administrativo BGC Ofertas</b>', {
          parse_mode: 'HTML',
          reply_markup: adminKeyboard()
        });
        return;
      }

      if (data === 'admin:new') {
        await safeAnswer(bot, query);
        const session = createWizardState(userId);
        setSession(userId, session);
        await bot.sendMessage(chatId, `🆕 Cadastro guiado iniciado.\n\n${wizardPrompt('name')}`, {
          parse_mode: 'HTML'
        });
        return;
      }

      if (data === 'admin:list') {
        await safeAnswer(bot, query);
        const offers = await ctx.offerService.list();
        await bot.sendMessage(chatId, formatOfferList(offers), {
          parse_mode: 'HTML',
          reply_markup: offers.length ? offerListKeyboard(offers) : adminKeyboard()
        });
        return;
      }

      if (data === 'admin:status') {
        await safeAnswer(bot, query);
        const stats = await ctx.offerService.operationalStatus();
        const scheduler = ctx.scheduler?.describe?.() || {};
        await bot.sendMessage(
          chatId,
          formatStatus(stats, {
            nodeEnv: ctx.config.nodeEnv,
            hasChannel: Boolean(ctx.config.channelId),
            adminCount: ctx.config.adminIds.length,
            autoNote: scheduler.note
          }),
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (data === 'admin:history') {
        await safeAnswer(bot, query);
        const history = await ctx.offerService.history(12);
        if (!history.length) {
          await bot.sendMessage(chatId, 'Nenhum evento registrado ainda.');
          return;
        }
        const lines = history.map((item) => {
          const at = new Date(item.at).toLocaleString('pt-BR');
          return `• ${at} — ${item.action} (${item.offerId})`;
        });
        await bot.sendMessage(chatId, `<b>Histórico recente</b>\n\n${lines.join('\n')}`, {
          parse_mode: 'HTML'
        });
        return;
      }

      if (data === 'admin:help') {
        await safeAnswer(bot, query);
        await bot.sendMessage(chatId, ADMIN_HELP_TEXT, { parse_mode: 'HTML' });
        return;
      }

      if (data.startsWith('offer:')) {
        const id = data.slice('offer:'.length);
        const offer = await ctx.offerService.getById(id);
        if (!offer) {
          await safeAnswer(bot, query, 'Oferta não encontrada.');
          return;
        }
        await safeAnswer(bot, query);
        await bot.sendMessage(chatId, formatOfferPreview(offer), {
          parse_mode: 'HTML',
          reply_markup: offerActionKeyboard(offer),
          disable_web_page_preview: true
        });
        return;
      }

      if (data.startsWith('preview:')) {
        const id = data.slice('preview:'.length);
        const offer = await ctx.offerService.getById(id);
        if (!offer) {
          await safeAnswer(bot, query, 'Oferta não encontrada.');
          return;
        }
        const result = await ctx.publishingService.preview(chatId, offer);
        await safeAnswer(bot, query, result.ok ? 'Prévia enviada.' : result.error);
        return;
      }

      if (data.startsWith('publish:')) {
        const id = data.slice('publish:'.length);
        const offer = await ctx.offerService.getById(id);
        if (!offer) {
          await safeAnswer(bot, query, 'Oferta não encontrada.');
          return;
        }
        const result = await ctx.publishingService.publish(offer, { actorId: userId });
        await safeAnswer(bot, query, result.ok ? 'Publicada.' : result.error);
        if (result.ok) await bot.sendMessage(chatId, 'Oferta publicada no canal.');
        else await bot.sendMessage(chatId, result.error);
        return;
      }

      if (data.startsWith('edit:')) {
        const id = data.slice('edit:'.length);
        const offer = await ctx.offerService.getById(id);
        if (!offer) {
          await safeAnswer(bot, query, 'Oferta não encontrada.');
          return;
        }
        const session = createWizardState(userId, { ...offer });
        session.step = 'preview';
        session.editingOfferId = offer.id;
        setSession(userId, session);
        await safeAnswer(bot, query);
        await bot.sendMessage(chatId, 'Selecione o campo para corrigir.', {
          reply_markup: EDIT_FIELD_KEYBOARD
        });
        return;
      }

      if (data.startsWith('delete:') && !data.startsWith('deleteok:')) {
        const id = data.slice('delete:'.length);
        await safeAnswer(bot, query);
        await bot.sendMessage(chatId, 'Confirma a exclusão desta oferta? Esta ação não pode ser desfeita.', {
          reply_markup: confirmDeleteKeyboard(id)
        });
        return;
      }

      if (data.startsWith('deleteok:')) {
        const id = data.slice('deleteok:'.length);
        const result = await ctx.offerService.remove(id, { actorId: userId });
        await safeAnswer(bot, query, result.ok ? 'Excluída.' : result.error);
        await bot.sendMessage(chatId, result.ok ? 'Oferta excluída.' : result.error);
        return;
      }

      if (data.startsWith('wizard:')) {
        await handleWizardCallback(bot, ctx, query, data, userId, chatId);
        return;
      }
    } catch (error) {
      logger.warn('Falha no callback.', error.message);
      await safeAnswer(bot, query, 'Não foi possível concluir a ação.');
    }
  });
}

async function handleWizardCallback(bot, ctx, query, data, userId, chatId) {
  const session = getSession(userId);

  if (data === 'wizard:backpreview') {
    if (!session) {
      await safeAnswer(bot, query, 'Sessão expirada.');
      return;
    }
    session.step = 'preview';
    session.editingField = null;
    setSession(userId, session);
    const preview = previewPayload(session);
    await safeAnswer(bot, query);
    await bot.sendMessage(chatId, preview.html, {
      parse_mode: 'HTML',
      reply_markup: preview.keyboard,
      disable_web_page_preview: true
    });
    return;
  }

  if (data.startsWith('wizard:field:')) {
    if (!session) {
      await safeAnswer(bot, query, 'Sessão expirada. Use /novaoferta.');
      return;
    }
    const field = data.slice('wizard:field:'.length);
    session.editingField = field;
    setSession(userId, session);
    await safeAnswer(bot, query);
    await bot.sendMessage(chatId, wizardPrompt(field), { parse_mode: 'HTML' });
    return;
  }

  if (data.startsWith('wizard:cancel:')) {
    clearSession(userId);
    await safeAnswer(bot, query, 'Cancelado.');
    await bot.sendMessage(chatId, 'Cadastro cancelado.');
    return;
  }

  if (data.startsWith('wizard:edit:')) {
    if (!session) {
      await safeAnswer(bot, query, 'Sessão expirada.');
      return;
    }
    await safeAnswer(bot, query);
    await bot.sendMessage(chatId, 'Selecione o campo para corrigir.', {
      reply_markup: EDIT_FIELD_KEYBOARD
    });
    return;
  }

  if (data.startsWith('wizard:draft:')) {
    if (!session) {
      await safeAnswer(bot, query, 'Sessão expirada.');
      return;
    }
    const saved = await ctx.offerService.saveDraft(session.data, { actorId: userId });
    clearSession(userId);
    await safeAnswer(bot, query, 'Rascunho salvo.');
    await bot.sendMessage(
      chatId,
      saved.ok
        ? `Rascunho salvo com ID <code>${saved.offer.id}</code>.`
        : 'Não foi possível salvar o rascunho.',
      { parse_mode: 'HTML' }
    );
    return;
  }

  if (data.startsWith('wizard:publish:')) {
    if (!session) {
      await safeAnswer(bot, query, 'Sessão expirada. Use /novaoferta.');
      return;
    }
    let offer = session.data;
    if (session.editingOfferId) {
      const updated = await ctx.offerService.update(session.editingOfferId, session.data, {
        actorId: userId
      });
      if (!updated.ok) {
        await safeAnswer(bot, query, 'Dados inválidos.');
        await bot.sendMessage(chatId, (updated.errors || [updated.error]).join('\n'));
        return;
      }
      offer = updated.offer;
    } else {
      const created = await ctx.offerService.create(session.data, { actorId: userId });
      if (!created.ok) {
        await safeAnswer(bot, query, 'Dados inválidos.');
        await bot.sendMessage(chatId, created.errors.join('\n'));
        return;
      }
      offer = created.offer;
      if (created.duplicates?.length) {
        await bot.sendMessage(
          chatId,
          `Atenção: possível duplicata de ${created.duplicates.length} oferta(s) já cadastrada(s). A publicação segue porque você confirmou.`
        );
      }
    }

    const result = await ctx.publishingService.publish(offer, { actorId: userId });
    if (!result.ok) {
      await safeAnswer(bot, query, result.error);
      await bot.sendMessage(
        chatId,
        `${result.error}\nA oferta foi salva como pronta com ID <code>${offer.id}</code>. Use /publicar ${offer.id} depois.`,
        { parse_mode: 'HTML' }
      );
      clearSession(userId);
      return;
    }
    clearSession(userId);
    await safeAnswer(bot, query, 'Publicada.');
    await bot.sendMessage(chatId, 'Oferta publicada no canal.');
  }
}

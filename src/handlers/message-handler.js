import { isAdmin } from '../config.js';
import {
  ADMIN_HELP_TEXT,
  adminKeyboard,
  formatOfferList,
  formatStatus,
  offerActionKeyboard
} from '../commands/admin.js';
import {
  applyWizardInput,
  createExtractionSession,
  createWizardState,
  imageReviewNote,
  missingRequiredFields,
  previewPayload,
  resolvePreviewOptions,
  wizardPrompt
} from './wizard.js';
import {
  analyzeLink,
  blockedMessage,
  extractionSummary,
  imageMissingPrompt,
  invalidLinkMessage,
  missingFieldsMessage,
  missingFieldsPrompt,
  nonProductMessage,
  PAGE_TYPES
} from '../services/offer-automation.js';
import { logger } from '../logger.js';

const SESSIONS = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const URL_ONLY_PATTERN = /^(https?:\/\/\S+)$/i;

export function extractLinkFromText(text) {
  const match = String(text ?? '').trim().match(URL_ONLY_PATTERN);
  return match ? match[1] : null;
}

// O Telegram entrega a foto em vários tamanhos; usamos o maior disponível.
export function pickLargestPhoto(photos) {
  if (!Array.isArray(photos) || !photos.length) return null;
  return photos.reduce((best, current) => {
    const bestSize = Number(best?.file_size || 0);
    const currentSize = Number(current?.file_size || 0);
    return currentSize >= bestSize ? current : best;
  });
}

async function showPreview(bot, ctx, chatId, session) {
  const options = await resolvePreviewOptions(ctx);
  const preview = previewPayload(session, options);
  const note = imageReviewNote(session.data);
  await bot.sendMessage(chatId, note ? `${note}\n\n${preview.html}` : preview.html, {
    parse_mode: 'HTML',
    reply_markup: preview.keyboard,
    disable_web_page_preview: true
  });
}

// Aplica o resultado padronizado do resolver à sessão de cadastro.
async function applyAnalysis(bot, ctx, chatId, userId, analysis) {
  const session = createExtractionSession(userId, analysis.offer);
  session.pageType = analysis.pageType;
  session.confidence = analysis.confidence || {};
  setSession(userId, session);

  await bot.sendMessage(chatId, extractionSummary(analysis), {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });

  const missing = missingRequiredFields(session.data);
  if (missing.length) {
    await bot.sendMessage(chatId, missingFieldsMessage(missing), { parse_mode: 'HTML' });
    await bot.sendMessage(chatId, missingFieldsPrompt(missing), { parse_mode: 'HTML' });
    return { ok: true, pending: true, missing };
  }

  if (!session.data.imageUrl && !session.data.imageFileId) {
    session.awaitingImage = true;
    setSession(userId, session);
    await bot.sendMessage(chatId, imageMissingPrompt(), { parse_mode: 'HTML' });
    return { ok: true, pending: true, missing: [], awaitingImage: true };
  }

  await showPreview(bot, ctx, chatId, session);
  return { ok: true, pending: false };
}

export async function handleOfferLink(bot, ctx, chatId, userId, link) {
  await bot.sendMessage(chatId, '🔎 Analisando o link…');
  const analysis = await analyzeLink(link, ctx.linkOptions || {});

  // Fonte bloqueada (403/429/5xx/timeout): reportamos o motivo, nunca inventamos dados.
  if (!analysis.ok && analysis.status && analysis.status !== 'OK') {
    logger.warn('Fonte indisponível na extração do link.', analysis.status);
    await bot.sendMessage(chatId, blockedMessage(analysis), { parse_mode: 'HTML', disable_web_page_preview: true });
    return { ok: false, blocked: true, status: analysis.status };
  }

  if (!analysis.ok) {
    logger.warn('Falha na extração automática do link.', analysis.error || analysis.status);
    await bot.sendMessage(chatId, invalidLinkMessage(), { parse_mode: 'HTML', disable_web_page_preview: true });
    return { ok: false };
  }

  // Página que não é produto individual (cupons, campanha, loja, categoria).
  if (analysis.pageType && analysis.pageType !== PAGE_TYPES.PRODUCT) {
    await bot.sendMessage(chatId, nonProductMessage(analysis), { parse_mode: 'HTML', disable_web_page_preview: true });
    return { ok: false, nonProduct: true, pageType: analysis.pageType };
  }

  return applyAnalysis(bot, ctx, chatId, userId, analysis);
}

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

      // Foto enviada pelo administrador: associada ao cadastro pendente.
      const photo = pickLargestPhoto(msg.photo);
      if (photo) {
        if (!session) {
          await bot.sendMessage(msg.chat.id, 'Envie primeiro o link do produto para eu associar a imagem.');
          return;
        }
        try {
          session.data.imageFileId = photo.file_id;
          session.data.imageUrl = null;
          session.awaitingImage = false;
          session.editingField = null;
          if (session.step === 'imageUrl') session.step = 'preview';
          setSession(userId, session);
          await bot.sendMessage(msg.chat.id, '🖼️ Imagem do produto associada ao cadastro.');
        } catch (error) {
          logger.warn('Falha ao associar a imagem enviada.', error.message);
          await bot.sendMessage(msg.chat.id, 'Não foi possível usar essa imagem. Envie novamente ou informe uma URL http/https.');
          return;
        }
        const missing = missingRequiredFields(session.data);
        if (missing.length) {
          await bot.sendMessage(msg.chat.id, missingFieldsPrompt(missing), { parse_mode: 'HTML' });
          return;
        }
        await showPreview(bot, ctx, msg.chat.id, session);
        return;
      }

      // Sem sessão ativa: um link isolado inicia o cadastro automático.
      if (!session) {
        const link = extractLinkFromText(msg.text || '');
        if (link) await handleOfferLink(bot, ctx, msg.chat.id, userId, link);
        return;
      }

      // Durante a coleta de campos ausentes, um link preenche a URL do produto.
      const activeStep = session.editingField || session.step;
      const pastedLink = extractLinkFromText(msg.text || '');
      if (pastedLink && ['url', 'imageUrl'].includes(activeStep)) {
        session.data[activeStep] = pastedLink;
        session.editingField = null;
        session.step = 'preview';
        setSession(userId, session);
        await showPreview(bot, ctx, msg.chat.id, session);
        return;
      }

      // Aguardando imagem: qualquer texto que não seja link é interpretado como "seguir sem imagem".
      if (session.awaitingImage && !pastedLink) {
        const missing = missingRequiredFields(session.data);
        if (missing.length) {
          await bot.sendMessage(msg.chat.id, missingFieldsPrompt(missing), { parse_mode: 'HTML' });
          return;
        }
        session.awaitingImage = false;
        setSession(userId, session);
        await showPreview(bot, ctx, msg.chat.id, session);
        return;
      }

      const result = applyWizardInput(session, msg.text || '');
      if (!result.ok) {
        await bot.sendMessage(msg.chat.id, result.error || 'Valor inválido. Tente novamente.');
        return;
      }
      setSession(userId, session);
      if (result.done) {
        if (!session.data.imageUrl && !session.data.imageFileId) {
          session.awaitingImage = true;
          setSession(userId, session);
          await bot.sendMessage(msg.chat.id, imageMissingPrompt(), { parse_mode: 'HTML' });
          return;
        }
        await showPreview(bot, ctx, msg.chat.id, session);
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

  bot.onText(/^\/novaoferta(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
    if (!isAdmin(ctx.config, msg.from?.id)) return denyAdmin(bot, msg.chat.id);
    const argument = String(match?.[1] || '').trim();
    const link = extractLinkFromText(argument);
    if (link) {
      await handleOfferLink(bot, ctx, msg.chat.id, msg.from.id, link);
      return;
    }
    if (argument) {
      await bot.sendMessage(
        msg.chat.id,
        'Não reconheci um link válido. Envie um link http/https ou use /novaoferta sem argumento para o cadastro guiado.'
      );
      return;
    }
    const session = createWizardState(msg.from.id);
    setSession(msg.from.id, session);
    await bot.sendMessage(
      msg.chat.id,
      `🆕 Cadastro guiado iniciado.\nEnvie o link do produto para o cadastro automático, ou preencha manualmente.\nUse /cancelar para abortar.\n\n${wizardPrompt('name')}`,
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
    const note = result.needsImageReview
      ? '\n⚠️ Esta oferta foi publicada sem imagem confirmada. Revise e reenvie com a imagem real se necessário.'
      : '';
    await bot.sendMessage(msg.chat.id, `Oferta publicada no canal.${note}`);
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

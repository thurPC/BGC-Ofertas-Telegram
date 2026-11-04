import { findDuplicates } from './offer-service.js';

export function evaluateReadiness(config, extras = {}) {
  const blockers = [];
  const warnings = [];

  if (!config?.channelId) blockers.push('Canal de publicação não configurado (TELEGRAM_CHANNEL_ID).');
  if (!config?.token) blockers.push('Token do bot não configurado (TELEGRAM_BOT_TOKEN).');
  if (!config?.adminIds?.length) blockers.push('Nenhum administrador configurado (ADMIN_IDS).');

  const hasFeed = Boolean(config?.feedUrl);
  const hasShopee = Boolean(config?.shopeeAppId && config?.shopeeAppSecret);
  if (config?.autoPublish && !hasFeed && !hasShopee) {
    blockers.push('Nenhuma fonte automática autenticada está configurada.');
  }
  if (config?.autoPublish && extras.requireShopee !== false && !hasShopee) {
    warnings.push('Publicação automática sem Shopee: apenas o feed JSON será usado.');
  }
  if (hasShopee && !config.shopeeAppSecret) {
    blockers.push('Credencial Shopee incompleta.');
  }

  const duplicateFn = extras.findDuplicates || findDuplicates;
  if (typeof duplicateFn !== 'function') {
    blockers.push('Proteção contra duplicidade ausente.');
  } else {
    const sample = duplicateFn(
      [{ id: '1', name: 'Item', store: 'Shopee', url: 'https://s.shopee.com.br/a', status: 'publicada' }],
      { name: 'Item', store: 'Shopee', url: 'https://s.shopee.com.br/a' }
    );
    if (!Array.isArray(sample) || sample.length === 0) {
      blockers.push('Proteção contra duplicidade não identificou repetição conhecida.');
    }
  }

  if (extras.testsFailed) {
    blockers.push('Há testes obrigatórios falhando. A publicação automática permanece bloqueada.');
  }

  return {
    ok: blockers.length === 0,
    readyForAutoPublish: blockers.length === 0 && Boolean(config?.autoPublish),
    blockers,
    warnings,
    autoPublish: Boolean(config?.autoPublish),
    hasShopee,
    hasFeed
  };
}

export function assertAutoPublishReadiness(config, extras = {}) {
  if (!config?.autoPublish) return evaluateReadiness(config, extras);
  const result = evaluateReadiness(config, extras);
  if (result.ok) return result;
  throw new Error(
    `Publicação automática bloqueada: ${result.blockers.join(' ')} OFFER_AUTO_PUBLISH permanece inutilizável até corrigir.`
  );
}

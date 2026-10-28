import { escapeHtml } from '../services/validation-service.js';

export const ADMIN_HELP_TEXT = [
  '🛠️ <b>Ajuda administrativa — BGC Ofertas</b>',
  '',
  '/admin — painel com botões',
  '/novaoferta — cadastro guiado',
  '/cancelar — cancela o cadastro em andamento',
  '/publicar — publica uma oferta pronta (informe o ID)',
  '/ofertas — lista ofertas cadastradas',
  '/status — estado operacional, sem dados sensíveis',
  '/ajuda_admin — esta mensagem',
  '',
  'Fluxo de cadastro: nome, preço atual, preço anterior (opcional), PIX (opcional), cupom e condições, imagem, link, loja e validade.',
  'Ao final há prévia. Só publica depois de confirmação explícita.',
  '',
  'A busca automática só funciona com fonte autorizada configurada e permanece desativada por padrão.'
].join('\n');

export function adminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🆕 Nova oferta', callback_data: 'admin:new' },
        { text: '📋 Ofertas', callback_data: 'admin:list' }
      ],
      [
        { text: '📊 Status', callback_data: 'admin:status' },
        { text: '🕘 Histórico', callback_data: 'admin:history' }
      ],
      [{ text: '🆘 Ajuda admin', callback_data: 'admin:help' }]
    ]
  };
}

export function offerListKeyboard(offers) {
  const rows = offers.slice(0, 12).map((offer) => [
    {
      text: `${statusIcon(offer.status)} ${truncate(offer.name || offer.id, 28)}`,
      callback_data: `offer:${offer.id}`
    }
  ]);
  rows.push([{ text: '⬅️ Painel', callback_data: 'admin:home' }]);
  return { inline_keyboard: rows };
}

export function offerActionKeyboard(offer) {
  const rows = [[{ text: '👁️ Prévia', callback_data: `preview:${offer.id}` }]];
  if (['rascunho', 'pronta'].includes(offer.status)) {
    rows.push([
      { text: '📢 Publicar', callback_data: `publish:${offer.id}` },
      { text: '✏️ Editar', callback_data: `edit:${offer.id}` }
    ]);
  }
  rows.push([{ text: '🗑️ Excluir', callback_data: `delete:${offer.id}` }]);
  rows.push([{ text: '⬅️ Lista', callback_data: 'admin:list' }]);
  return { inline_keyboard: rows };
}

export function confirmPublishKeyboard(tempId) {
  return {
    inline_keyboard: [
      [{ text: '📢 Publicar agora', callback_data: `wizard:publish:${tempId}` }],
      [{ text: '💾 Salvar rascunho', callback_data: `wizard:draft:${tempId}` }],
      [{ text: '✏️ Corrigir', callback_data: `wizard:edit:${tempId}` }],
      [{ text: '❌ Cancelar', callback_data: `wizard:cancel:${tempId}` }]
    ]
  };
}

export function confirmDeleteKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirmar exclusão', callback_data: `deleteok:${id}` },
        { text: '❌ Cancelar', callback_data: `offer:${id}` }
      ]
    ]
  };
}

export function statusIcon(status) {
  switch (status) {
    case 'rascunho':
      return '📝';
    case 'pronta':
      return '✅';
    case 'publicada':
      return '📢';
    case 'expirada':
      return '⏳';
    case 'cancelada':
      return '🚫';
    default:
      return '•';
  }
}

export function formatOfferList(offers) {
  if (!offers.length) return 'Nenhuma oferta cadastrada ainda.';
  const lines = offers.slice(0, 20).map((offer) => {
    const name = escapeHtml(offer.name || 'Sem nome');
    return `${statusIcon(offer.status)} <code>${escapeHtml(offer.id)}</code> — <b>${name}</b> (${escapeHtml(offer.status)})`;
  });
  return `<b>Ofertas cadastradas</b>\n\n${lines.join('\n')}`;
}

export function formatStatus(stats, extra = {}) {
  const auto = extra.autoNote || 'Publicação automática desativada.';
  return [
    '📊 <b>Status operacional</b>',
    '',
    `Ofertas: ${stats.total}`,
    `Rascunhos: ${stats.rascunho}`,
    `Prontas: ${stats.pronta}`,
    `Publicadas: ${stats.publicada}`,
    `Expiradas: ${stats.expirada}`,
    `Canceladas: ${stats.cancelada}`,
    '',
    `Ambiente: ${escapeHtml(extra.nodeEnv || 'production')}`,
    `Canal configurado: ${extra.hasChannel ? 'sim' : 'não'}`,
    `Administradores: ${extra.adminCount ?? 0}`,
    '',
    escapeHtml(auto)
  ].join('\n');
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

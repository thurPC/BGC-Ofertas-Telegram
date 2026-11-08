import { isAllowedPuxadorSource } from './source-config.js';
import { parseShopeeChannelPost } from './shopee-post-parser.js';

export function registerPuxadorChannelPostHandler(bot, { allowedChatIds = [], inboxStore, logger = null } = {}) {
  if (!bot || !inboxStore) return false;
  bot.on('channel_post', async (message) => {
    try {
      if (!isAllowedPuxadorSource(message?.chat?.id, allowedChatIds)) return;
      const capture = parseShopeeChannelPost(message);
      if (!capture) return;
      const result = await inboxStore.enqueue(capture);
      if (result.ok) {
        logger?.info?.(
          result.duplicate ? 'Puxador: oferta Shopee repetida consolidada.' : 'Puxador: nova oferta Shopee capturada.',
          { sourceChatId: capture.sourceChatId, sourceMessageId: capture.sourceMessageId, productKey: result.item?.productKey }
        );
      }
    } catch (error) {
      logger?.warn?.('Puxador: falha ao processar publicação de canal.', error?.message || 'erro desconhecido');
    }
  });
  return true;
}

import { logger } from '../logger.js';

export const PUBLIC_BOT_COMMANDS = [
  { command: 'start', description: 'Apresentação do BGC Ofertas' },
  { command: 'ajuda', description: 'Lista de comandos' },
  { command: 'sobre', description: 'Sobre o BGC Ofertas' },
  { command: 'modelo', description: 'Modelo de publicação (equipe)' },
  { command: 'categorias', description: 'Painel de categorias (equipe)' },
  { command: 'horario', description: 'Horário de operação 24h (equipe)' }
];

export const ADMIN_BOT_COMMANDS = [
  ...PUBLIC_BOT_COMMANDS,
  { command: 'admin', description: 'Painel administrativo' },
  { command: 'novaoferta', description: 'Cadastro de oferta' },
  { command: 'ofertas', description: 'Lista ofertas cadastradas' },
  { command: 'status', description: 'Estado operacional' },
  { command: 'publicar', description: 'Publicar oferta pelo ID' },
  { command: 'cancelar', description: 'Cancelar cadastro em andamento' },
  { command: 'ajuda_admin', description: 'Ajuda administrativa' }
];

export function adminCommandScopes(adminIds = []) {
  return adminIds.map((id) => ({
    type: 'chat',
    chat_id: String(id)
  }));
}

export async function registerBotMenuCommands(bot, config, log = logger) {
  try {
    await bot.setMyCommands(PUBLIC_BOT_COMMANDS);
  } catch (error) {
    log.warn('Não foi possível registrar os comandos públicos no Telegram.', error.message);
  }

  for (const scope of adminCommandScopes(config?.adminIds)) {
    try {
      await bot.setMyCommands(ADMIN_BOT_COMMANDS, { scope });
    } catch (error) {
      log.warn('Não foi possível registrar os comandos administrativos no Telegram.', error.message);
    }
  }
}

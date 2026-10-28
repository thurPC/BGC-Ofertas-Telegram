export const START_TEXT = [
  '🔥 <b>BGC OFERTAS</b>',
  '',
  'Promoções e oportunidades com cara de gamer: direto ao ponto, no celular e sem enrolação.',
  '',
  'Aqui você encontra ofertas cadastradas pela equipe BGC Store. Nada de preço inventado: só publicamos o que foi confirmado.',
  '',
  '📌 Comandos:',
  '/start — apresentação',
  '/ajuda — lista de comandos',
  '/sobre — quem somos',
  '',
  'Siga o canal BGC Ofertas para receber as publicações. Se você é administrador, use /admin.'
].join('\n');

export const HELP_TEXT = [
  '🆘 <b>Ajuda — BGC Ofertas</b>',
  '',
  '<b>Comandos públicos</b>',
  '/start — apresentação e instruções',
  '/ajuda — esta lista',
  '/sobre — descrição do projeto',
  '',
  'As ofertas são publicadas no canal configurado. Este chat privado serve para apresentação e, para a equipe, para o cadastro.'
].join('\n');

export const ABOUT_TEXT = [
  '📢 <b>Sobre o BGC Ofertas</b>',
  '',
  'O BGC Ofertas é o canal de promoções da identidade BGC Store: preto, grafite, cinza-escuro e verde, estilo gamer, moderno e profissional.',
  '',
  'Publicamos ofertas com nome, preço confirmado, cupom quando existir, condições claras e link válido. Campos sem confirmação são omitidos.',
  '',
  'Não inventamos desconto, estoque, frete ou avaliação. Se uma informação não foi conferida, ela não aparece na mensagem.'
].join('\n');

export function registerPublicCommands(bot) {
  bot.onText(/^\/start(?:@\w+)?(?:\s|$)/, async (msg) => {
    await bot.sendMessage(msg.chat.id, START_TEXT, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/ajuda(?:@\w+)?(?:\s|$)/, async (msg) => {
    await bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.onText(/^\/sobre(?:@\w+)?(?:\s|$)/, async (msg) => {
    await bot.sendMessage(msg.chat.id, ABOUT_TEXT, { parse_mode: 'HTML' });
  });
}

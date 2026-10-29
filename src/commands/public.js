export const START_TEXT = [
  '🔥 <b>BGC OFERTAS</b>',
  '',
  'Promoções e oportunidades com cara de gamer: direto ao ponto, no celular e sem enrolação.',
  '',
  'Aqui você encontra ofertas cadastradas pela equipe BGC Store. Nada de preço inventado: só publicamos o que foi confirmado.',
  '',
  'Siga o canal BGC Ofertas para receber as promoções. Inscritos não precisam enviar comandos: o link de compra vai no texto de cada publicação e os comentários ficam no grupo de discussão vinculado ao canal.',
  '',
  'Se você faz parte da equipe, use /admin.'
].join('\n');

export const HELP_TEXT = [
  '🆘 <b>Ajuda — BGC Ofertas</b>',
  '',
  '<b>Comandos públicos</b>',
  '/start — apresentação e instruções',
  '/ajuda — esta lista',
  '/sobre — descrição do projeto',
  '',
  'As ofertas são publicadas no canal. Inscritos não precisam usar comandos: basta abrir o link no texto e comentar no grupo de discussão do canal.',
  '',
  'Este chat privado serve para apresentação e, para a equipe, para o cadastro.'
].join('\n');

export const ABOUT_TEXT = [
  '📢 <b>Sobre o BGC Ofertas</b>',
  '',
  'O BGC Ofertas é o canal de promoções da identidade BGC Store: preto, grafite, cinza-escuro e verde, estilo gamer, moderno e profissional.',
  '',
  'Publicamos ofertas com foto real quando disponível, nome, preço confirmado, cupom quando existir e o link de compra no próprio texto. Sem botões inline na publicação, para preservar os comentários do grupo de discussão do canal. Campos sem confirmação são omitidos.',
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

# BGC Ofertas

Bot Telegram da identidade **BGC Store** para cadastro, pré-visualização e publicação de promoções no canal BGC Ofertas.

Estilo visual: preto, grafite, cinza-escuro e verde. Mensagens em português brasileiro, com títulos, emojis e o link de compra no próprio texto. As publicações do canal não usam botões inline.

Esta primeira versão prioriza o **cadastro manual**, a **prévia** e a **confirmação administrativa** antes de qualquer publicação. A busca automática existe como arquitetura modular e permanece **desativada** até haver uma fonte real e autorizada.

## Funcionalidades

- Comandos públicos: `/start`, `/ajuda`, `/sobre`
- Painel administrativo com botões inline
- Cadastro guiado de ofertas com prévia e confirmação
- Publicação no canal via `sendPhoto` ou `sendMessage`, com foto real quando disponível
- Link de compra no texto da mensagem, sem botões inline no canal
- Estados: rascunho, pronta, publicada, expirada e cancelada
- Detecção de possíveis duplicatas (sem exclusão automática)
- Armazenamento JSON com gravação atômica e controle de concorrência
- Arquitetura pronta para fontes automáticas autorizadas (desligada por padrão)

O bot **não inventa** preços, descontos, cupons, avaliações, frete, estoque, imagens ou URLs. Campos sem confirmação são omitidos.

## Tecnologias e requisitos

- Node.js 20 LTS ou superior
- JavaScript com ES Modules
- `node-telegram-bot-api`
- `dotenv`
- Testes com `node:test`
- Sem Docker obrigatório e sem serviços pagos

## Criar o bot no BotFather

1. Abra o Telegram e converse com [@BotFather](https://t.me/BotFather).
2. Envie `/newbot` e escolha o nome de exibição **BGC Ofertas**.
3. Defina um username disponível, por exemplo `bgcofertas_bot`.
4. Copie o token gerado. Ele entra somente em `.env`, nunca no código nem no GitHub.
5. Opcional: `/setdescription`, `/setabouttext` e `/setuserpic` no BotFather.

## Criar o canal e permissões

1. Crie um canal (público ou privado) para o BGC Ofertas.
2. Adicione o bot como **administrador**.
3. Conceda permissão para publicar mensagens. Sem isso a API recusa o envio.
4. Se quiser comentários, vincule um **grupo de discussão** ao canal nas configurações do Telegram. As publicações não levam botões inline, para não interferir nesse recurso nativo.
5. Obtenha o ID do canal:
   - Canal público: use `@nome_do_canal`
   - Canal privado: encaminhe uma mensagem para um bot de identificação de ID ou use o ID numérico no formato `-100...`
6. Coloque esse valor em `TELEGRAM_CHANNEL_ID`.

Este projeto **não contorna** permissões do Telegram. O bot precisa ser adicionado ao canal com direitos adequados.

## Configurar token e IDs administrativos

1. Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

2. Preencha:

```bash
TELEGRAM_BOT_TOKEN=cole-o-token-do-botfather
TELEGRAM_CHANNEL_ID=-1001234567890
ADMIN_IDS=123456789,987654321
```

`ADMIN_IDS` aceita um ou mais IDs numéricos do Telegram, separados por vírgula. Para descobrir seu ID, envie uma mensagem ao bot depois de iniciar e consulte um serviço de identificação de ID, ou use um bot auxiliar de confiança. Usuários comuns nunca publicam, editam ou excluem ofertas.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | sim | Token do BotFather |
| `TELEGRAM_CHANNEL_ID` | sim | ID ou @username do canal |
| `ADMIN_IDS` | sim | IDs numéricos autorizados |
| `NODE_ENV` | não | Padrão: `production` |
| `OFFER_AUTO_PUBLISH` | não | Padrão: `false` |
| `OFFER_CHECK_INTERVAL_MINUTES` | não | Intervalo da consulta automática. Padrão: `60` |
| `MAX_OFFERS_PER_RUN` | não | Limite por ciclo automático. Padrão: `5` |
| `DATA_DIR` | não | Pasta dos JSON. Padrão: `./data` |
| `LOG_LEVEL` | não | `error`, `warn`, `info` ou `debug` |
| `OFFER_FEED_URL` | não | URL https de um feed JSON **autorizado** |
| `OFFER_MAX_PRICE` | não | Preço máximo para fontes automáticas |
| `OFFER_MIN_DISCOUNT_PERCENT` | não | Desconto mínimo calculável |
| `OFFER_ALLOWED_STORES` | não | Lojas permitidas, separadas por vírgula |
| `OFFER_ALLOWED_HOURS` | não | Horários `8-22` ou lista `9,10,11` |

Na inicialização o bot informa quais variáveis estão ausentes **sem revelar valores**.

## Instalação e inicialização

```bash
npm install
```

```bash
npm start
```

Equivalente:

```bash
node index.js
```

O processo usa **long polling**. Não há servidor web. Encerre com `Ctrl+C` para um shutdown controlado.

Há proteção contra instância duplicada (`data/bot.pid`). Se outra cópia já estiver em polling, esta encerra para evitar conflito 409 da API.

## Comandos públicos

| Comando | Função |
| --- | --- |
| `/start` | Apresentação e instruções |
| `/ajuda` | Lista de comandos |
| `/sobre` | Descrição do BGC Ofertas |

## Comandos administrativos

Somente IDs em `ADMIN_IDS`. A verificação ocorre também nos callbacks dos botões.

| Comando | Função |
| --- | --- |
| `/admin` | Painel com botões inline |
| `/novaoferta` | Cadastro guiado |
| `/cancelar` | Cancela o cadastro em andamento |
| `/publicar ID` | Publica uma oferta validada |
| `/ofertas` | Lista ofertas cadastradas |
| `/status` | Estado operacional, sem dados sensíveis |
| `/ajuda_admin` | Instruções administrativas |

## Cadastro e publicação de ofertas

O fluxo de `/novaoferta` solicita, nesta ordem:

1. Nome do produto
2. Preço atual
3. Preço anterior (opcional)
4. Preço PIX (opcional)
5. Cupom (opcional)
6. Condições do cupom (opcional)
7. URL da imagem (opcional)
8. Link de compra (obrigatório)
9. Loja
10. Validade (opcional)

Envie `pular` nos campos opcionais. Ao final o bot mostra a prévia no modelo:

```text
🔥 NOME DO PRODUTO

💰 Preço promocional: R$ XX,XX
🏷️ Cupom: CUPOM (somente se existir)

🛒 Link de compra: https://link-real-do-produto

📢 Compartilhe com seus amigos!
```

Campos sem confirmação (preço anterior, PIX, cupom, condições, loja, validade) são omitidos. Não há botão **COMPRAR AGORA** nem qualquer outro botão inline na publicação do canal. Inscritos não precisam enviar comandos: o link está no texto e os comentários ficam no grupo de discussão vinculado ao canal.

Você pode **publicar agora**, **salvar rascunho**, **corrigir** ou **cancelar**. Nenhuma publicação ocorre sem essa confirmação.

Validações:

- Preços no formato brasileiro (`199,90`, `1.299,00`)
- Valores negativos recusados
- URLs apenas `http` ou `https`
- Campos obrigatórios
- Limites de tamanho das mensagens do Telegram

Se a imagem falhar, a oferta é publicada só com texto. Links inválidos impedem a publicação.

## Fontes automáticas autorizadas

A pasta `src/sources/` define a interface:

- buscar produtos
- obter preços, imagens, cupons e links
- informar origem e horário da consulta
- aplicar filtros de preço, desconto, loja e horário

Há um conector HTTP de **feed JSON autorizado** (`OFFER_FEED_URL`). O formato esperado é:

```json
{
  "offers": [
    {
      "name": "Nome do produto",
      "price": 99.90,
      "previousPrice": 149.90,
      "pixPrice": 94.90,
      "coupon": "CUPOM",
      "couponConditions": "Regras do cupom",
      "imageUrl": "https://exemplo.com/foto.png",
      "url": "https://link-real-do-produto",
      "store": "Loja"
    }
  ]
}
```

Campos obrigatórios: `name`, `price`, `url`, `store`. Os demais são omitidos se vazios. A URL do produto é preservada exatamente como veio no feed (incluindo parâmetros de afiliado). Itens inválidos são ignorados e registrados; falha HTTP, JSON quebrado, timeout ou fonte indisponível não derrubam o bot.

Feed de teste deste repositório:

```text
https://raw.githubusercontent.com/thurPC/BGC-Ofertas-Telegram/main/feed.json
```

Mercado Livre, Amazon e Shopee **não** estão integrados por API própria. Só existe a leitura do feed configurado. Não inventamos endpoints, chaves ou scraping.

Se nenhuma fonte estiver configurada, o modo manual funciona normalmente. Com o feed configurado e `OFFER_AUTO_PUBLISH=false` (padrão), o bot **consulta** o JSON, mas **não importa** e **não publica** no canal. Duplicatas (mesmo `id` externo, mesmo link ou mesmo nome+loja) não são importadas de novo quando a importação/publicação automática estiver em uso.

Não faça scraping indiscriminado, não contorne CAPTCHA e não viole termos de serviço.

## Testes

```bash
npm test
```

Os testes não usam token real. Cobrem:

- conversão e validação de preços
- cálculo de desconto e ausência de preço anterior
- escape de HTML
- URLs e campos obrigatórios
- autorização administrativa
- duplicatas
- leitura/gravação JSON e recuperação de arquivo corrompido
- formatação com e sem imagem
- ausência de botões inline na publicação
- ausência de fontes automáticas
- leitura do feed JSON (sucesso, vazio, inválido, falha HTTP, timeout e deduplicação)

## Publicação no GitHub

1. Confirme que `.env` está no `.gitignore`.
2. Não commite `data/*.json`, logs ou tokens.
3. Envie a branch `main`.

```bash
git add .
git status
git commit -m "feat: primeira versao funcional do BGC Ofertas"
git push -u origin main
```

Revise o diff antes do push. Se o remoto tiver histórico conflitante, resolva localmente; este projeto não força push nem apaga histórico.

## Hospedagem gratuita

Opções comuns, todas com limitações:

- **Railway / Render / Fly.io** — processos persistentes, plano gratuito sujeito a cotas
- **Oracle Cloud Always Free** ou um VPS mínimo — exige manutenção
- **GitHub Actions** não é adequado para um bot em long polling contínuo

Serviços gratuitos podem:

- suspender o processo por inatividade
- reiniciar e perder arquivos locais
- limitar CPU, memória e tempo de execução

Como o armazenamento é um JSON em disco (`data/offers.json`), prefira um volume persistente. Sem volume, rascunhos e histórico somem no redeploy.

Webhook exigiria HTTPS público. Esta versão usa long polling de propósito, para não criar servidor web desnecessário.

## Limitações

- Um processo por token. Duas instâncias geram erro 409.
- JSON não substitui banco em alto volume.
- Hospedagem efêmera perde dados se `data/` não for persistente.
- Fontes de afiliados oficiais dependem de cadastro externo, que este repositório não inventa.
- O Telegram limita tamanho de mensagem (4096) e de legenda (1024). Ofertas muito longas são truncadas.
- Imagens precisam ser URLs acessíveis publicamente.

## Solução de problemas

| Sintoma | Causa provável | O que fazer |
| --- | --- | --- |
| Bot não inicia e cita variáveis ausentes | `.env` incompleto | Copie `.env.example` e preencha |
| `409 Conflict` | Duas instâncias | Encerre a outra e apague `data/bot.pid` se o pid estiver morto |
| Não publica no canal | Bot sem permissão | Torne o bot administrador do canal |
| `chat not found` | ID do canal errado | Confira `TELEGRAM_CHANNEL_ID` |
| Imagem não aparece | URL inacessível | Publique só texto ou use outra URL |
| Comando admin ignorado | ID fora de `ADMIN_IDS` | Confira o ID numérico |
| Dados sumiram após deploy | Disco efêmero | Use volume persistente |

O bot não executa comandos de sistema enviados por usuários e não expõe stack traces nem tokens em mensagens.

## Segurança

- Tokens só em `.env`
- `.gitignore` cobre `.env`, JSON de dados, logs e temporários
- Autorização conferida em cada comando e callback
- HTML escapado nas mensagens
- Encerramento controlado em `SIGINT`/`SIGTERM`
- Logs de produção mostram só a mensagem do erro, não o token

## Licença

MIT. Veja `LICENSE`.

## Primeiro teste real

1. Preencha `.env`.
2. `npm install` e `npm start`.
3. No Telegram, envie `/start` ao bot.
4. Com um ID de `ADMIN_IDS`, envie `/admin` e `/novaoferta`.
5. Conclua o cadastro, revise a prévia e só então confirme a publicação.
6. Verifique a mensagem no canal.

Próximo passo de hospedagem: escolha um serviço com processo 24h e disco persistente, defina as mesmas variáveis de ambiente e inicie com `npm start`. Não ligue `OFFER_AUTO_PUBLISH` sem uma fonte autorizada configurada.

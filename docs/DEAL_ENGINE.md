# BGC Deal Engine

Motor de descoberta, identificação, comparação e seleção de ofertas. Ele avalia oportunidades; **não publica sozinho**. `OFFER_AUTO_PUBLISH` permanece `false` até autorização explícita.

## Arquitetura

Fluxo:

descoberta -> identificação -> classificação -> histórico -> comparação -> pontuação -> validação -> deduplicação -> afiliado -> revalidação -> fila -> Telegram

Módulos em `src/deal-engine/`:

| Módulo | Responsabilidade |
| --- | --- |
| `adapters.js` | Normaliza produtos das fontes existentes |
| `identity.js` | GTIN, MPN, marca + modelo + variante |
| `classification.js` | Taxonomia estruturada (não só palavra-chave) |
| `price-intelligence.js` / `price-store.js` | Histórico persistente e estatísticas |
| `comparison.js` | Comparação só entre o mesmo modelo/variante |
| `scoring.js` | Deal Score 0-100 |
| `confidence.js` | Confidence Score independente |
| `quality-gate.js` | Rejeições eliminatórias com motivo |
| `dedup.js` | Cooldown, diversidade, republicação só com melhora |
| `queue.js` | Fila ordenada e revalidação |
| `pipeline.js` | Orquestração e dry-run |
| `diagnostics.js` | Métricas por ciclo |
| `semantic.js` | Similaridade auxiliar; nunca substitui identidade |
| `affiliate.js` | Validação de link afiliado (não altera o fluxo Shopee) |
| `discovery.js` | Adaptadores json-feed, Shopee e Mercado Livre via feed |
| `cache.js` | Cache de ciclo; snapshot velho não conta como preço atual |

A seleção automática **legada** (`offer-scorer`) continua no comando. O Deal Engine observa cada ciclo. Só assume a seleção se `DEAL_ENGINE_CONTROL_SELECTION=true`.

## Fontes

Prioriza as fontes já existentes:

- Feed JSON autorizado (`OFFER_FEED_URL`)
- Shopee Affiliate Open API (fluxo atual preservado, inclusive o tratamento do erro `10000`)

Mercado Livre entra quando o item já vem no feed normalizado. Não há scraping nem endpoints privados.

Cada adaptador devolve o formato normalizado (identificadores, preço, frete, cupom, estoque, vendedor, URL). Produto sem a palavra-chave da busca **não é descartado só por isso**.

## Identidade

Prioridade: GTIN/EAN -> MPN -> marca + modelo + variante -> atributos técnicos.

Variantes distintas nunca compartilham histórico nem comparação. Exemplos: RTX 5060 ≠ 5060 Ti, Ryzen 5 5600 ≠ 5600X, SSD 1 TB ≠ 2 TB, DDR4 ≠ DDR5, 127 V ≠ 220 V.

Identidade incerta vai para quarentena e não publica.

## Classificação

Taxonomia configurável em `taxonomy.js` (informática, eletrodomésticos, eletrônicos relacionados). Título ajuda, mas não é o único fundamento.

- Livros, e-books, revistas e publicações: inelegíveis
- Jogos de tabuleiro: não são livros; só elegíveis se a categoria estiver habilitada
- `unknown`: não publica

## Histórico de preços

Arquivo persistente `data/price-history.json` (separado de `offers.json`).

Estatísticas: média 7/30/90, mediana 30/90, mínima/máxima observada, tendência, frequência de alteração.

O preço original anunciado pela loja **não** é histórico real. Aumento artificial do "de/por" é sinalizado e não gera Deal Score alto.

Retenção padrão: 365 dias. A limpeza não apaga a janela necessária para 90 dias.

## Deal Score e Confidence Score

Pesos iniciais do Deal Score:

- Desconto real contra mediana histórica: 35
- Proximidade da mínima: 20
- Comparação entre lojas: 15
- Vendedor: 10
- Demanda: 10
- Economia após frete/cupom: 5
- Atualidade/estoque: 5

Ausência de dado = ausência de evidência (zero naquele critério). Comissão **nunca** aumenta o Deal Score.

Confidence Score avalia identidade, categoria, identificadores, histórico, atualidade, fonte, estoque, URL e variante.

Limiares iniciais (calibração): Deal Score 75, Confidence 90.

## Quality gate e fila

Falha em qualquer condição obrigatória impede a fila. Motivos são registrados, nunca silenciosos.

Estados: `discovered`, `identified`, `classified`, `evaluated`, `rejected`, `queued`, `revalidating`, `published`, `expired`, `failed`, `quarantine`.

Antes de publicar: revalida preço, estoque e URL. Preço pior ou oferta sumida remove o item.

## Configuração

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `DEAL_ENGINE_ENABLED` | `true` | Avalia o ciclo (observação) |
| `DEAL_ENGINE_CONTROL_SELECTION` | `false` | Se `true`, substitui o ranking legado |
| `DEAL_ENGINE_GATE_ON_PUBLISH` | `false` | Se `true`, o quality gate e a revalidação bloqueiam `publish()` |
| `DEAL_ENGINE_MIN_SCORE` | `75` | Deal Score mínimo |
| `DEAL_ENGINE_MIN_CONFIDENCE` | `90` | Confidence mínimo |
| `DEAL_ENGINE_COOLDOWN_HOURS` | `24` | Cooldown por produto |
| `DEAL_ENGINE_VARIANT_COOLDOWN_HOURS` | `12` | Cooldown por variante |

`OFFER_AUTO_PUBLISH` continua `false`. O intervalo de busca permanece o valor atual do projeto (`OFFER_CHECK_INTERVAL_MINUTES`, padrão 30; na Hokas pode ser 5).

## Dry-run

Sem `--file`, o dry-run consulta as fontes já configuradas (`OFFER_FEED_URL` e/ou Shopee Affiliate) e avalia as ofertas reais pelo motor. Nada é enviado ao Telegram.

```bash
npm run dry-run
npm run dry-run -- --limit 20 --data-dir ./data
```

`--file` continua disponível como override para um dump autorizado:

```bash
npm run dry-run -- --file test/fixtures/deal-engine-offers.json --data-dir ./data
```

O relatório inclui origem (`configured-sources` ou `file`), erros por fonte, identificação, categoria, histórico, scores, aprovação/rejeição e a mensagem que **seria** publicada.

Histórico insuficiente é explícito. Mocks de teste não provam desempenho real de mercado.

## Diagnóstico

Comando administrativo `/diagnostico`: descobertos, identificados, classificados, rejeitados (com motivos), ranking, fila, publicados, expirados, falhas de fonte e tempo do ciclo. Sem tokens nem segredos.

## Testes

```bash
npm test
npm run syntax
```

Os testes do Deal Engine cobrem identidade, variantes incompatíveis, classificação, livros, histórico, preço inflado, scores, gate, dedup, expiração, persistência, dry-run, mock de Telegram, fail-closed e auto-publish desligado.

Não dependem de internet.

## Persistência

- Histórico e fila: `data/price-history.json` (JSON atômico com lock; não é SQLite)
- A fila sobrevive a reinício. Revalidação ocorre antes de assumir a seleção (`DEAL_ENGINE_CONTROL_SELECTION`) e, se ligado, antes de `publish()`.
- Cache de estatísticas vale só no ciclo corrente e ignora `fetchedAt` antigo.

## Limitações conhecidas

- Sem histórico real o Deal Score fica baixo de propósito (fail-closed)
- APIs de fabricantes/catálogos oficiais não estão autenticadas neste repositório
- Mercado Livre só entra via feed já autorizado; não há scraping nem API privada
- Comparação semântica é auxiliar e nunca confirma identidade
- `DEAL_ENGINE_CONTROL_SELECTION` e `DEAL_ENGINE_GATE_ON_PUBLISH` desligados até calibração
- Intervalo de busca: `OFFER_CHECK_INTERVAL_MINUTES` (padrão 30; a Hokas pode usar 5). Não altera env de produção
- Não está pronto para produção só porque os unitários passaram

## Validação na Hokas

1. Manter `OFFER_AUTO_PUBLISH=false`
2. Conferir `/status` e `/diagnostico` após um ciclo
3. Rodar `npm run dry-run` (fontes reais configuradas) ou `--file` com um dump autorizado
4. Não ativar publicação automática sem revisão humana do relatório

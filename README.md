# AI Trading Scanner

Extensão Chrome/Edge Manifest V3 com arquitetura multi-plataforma para captura, normalização e análise de mercado. A CasaTrade é a primeira integração real; o core não depende dela.

## Estado atual — v0.3.3

O projeto possui:

- Side Panel vinculado à aba ativa da plataforma.
- Investigador de feed em `src/content/network-probe.js` para observar WebSocket/fetch/XHR recebidos pela própria página, sem coletar cookies, headers, corpo de requisição, query string ou campos de autenticação/sessão.
- Catálogo de ativos/linhas observados no tráfego da plataforma, com preço, timeframe, expiração e payout quando esses campos aparecem no feed.
- Configuração rápida de timeframe de análise e expiração-alvo diretamente no Side Panel.
- Botões de **preparar compra/venda** que registram a intenção e levam o usuário à aba da plataforma; a ordem não é enviada automaticamente e continua exigindo confirmação manual na casa.
- Service worker em modo ES module.
- Pipeline em `src/core/orchestrator.js`: snapshot → CandleBuilder → análise → confluência → quality gate → risk guard/dedupe → state machine → `scannerState.signal`.
- Indicadores centralizados em `src/core/indicators.js` (SMA, EMA, RSI, MACD, ATR e Bollinger).
- `src/platforms/registry.js` como fonte de configuração das plataformas suportadas.
- `src/platforms/base-adapter.js` como contrato/base comum de adapter.
- Um único content script genérico em `src/content/generic-adapter.js`, reutilizado por todas as casas registradas.
- Configurações de seletores por plataforma em `settings.selectorsByPlatform[platformId]`.
- Backend Node com validação de payload, limite de corpo, `x-api-key` e CORS por allowlist.
- Admin Dashboard separado em `apps/admin-dashboard/`.
- Testes unitários com `node:test` e CI no GitHub Actions.

> Importante: a CasaTrade continua com `capabilities.structuredQuotes=false`. Enquanto a fonte estruturada real não for validada, os dados observados por DOM/rede são tratados como diagnóstico/provisórios e não liberam uma confirmação operacional como se fossem um feed oficialmente validado.

## Arquitetura

```text
Plataforma aberta na aba atual
  ↓
Platform Registry
  ↓
Network Probe + Generic Content Adapter
  ↓
Snapshot / catálogo normalizado
  ↓
CandleBuilder por platformId:asset:timeframe
  ↓
Analysis / Indicators
  ↓
Confluence
  ↓
Quality Gate + Risk Controls
  ↓
Signal State Machine
  ↓
chrome.storage.local → scannerState.signal
  ↓
Side Panel
```

Pastas principais:

```text
src/core/       lógica pura e orquestração
src/platforms/  registry e base adapter
src/services/   telemetria / providers
src/content/    captura genérica + diagnóstico de rede
src/sidepanel/  interface principal
src/admin/      configurações locais da extensão
backend/        API Node
apps/admin-dashboard/ dashboard central
```

## Ativos, linhas, timeframe e expiração

O diagnóstico de rede procura objetos recebidos pela página contendo campos como `symbol/asset/instrument`, `price/bid/ask`, `timeframe`, `expiration` e `payout`.

Quando encontra candidatos, o background monta `scannerState.marketCatalog`:

```js
{
  assets: ['EUR/USD', 'GBP/USD'],
  timeframes: ['M1'],
  expirations: ['60s'],
  lines: [
    { asset: 'EUR/USD', price: 1.2345, timeframe: 'M1', expiration: '60s', payout: 85 }
  ]
}
```

O usuário escolhe no Side Panel:

- timeframe de análise: AUTO, M1, M5 ou M15;
- expiração-alvo: AUTO, 30s, 60s, 2m ou 5m;
- valores adicionais encontrados no feed também podem aparecer nas listas.

O `orchestrator` usa `analysisTimeframe` na chave dos candles, portanto diferentes casas, ativos e timeframes continuam isolados.

## Compra e venda

A extensão possui botões **PREPARAR COMPRA** e **PREPARAR VENDA**. Eles:

1. registram a direção, ativo, timeframe e expiração-alvo em `scannerState.tradeIntent`;
2. trazem a aba da plataforma para frente;
3. deixam a confirmação final para o usuário na própria plataforma.

Não existe clique automático de ordem nem execução autônoma de compra/venda.

## Como cadastrar uma nova plataforma

A extensão foi estruturada para que uma nova casa não exija um novo content script.

### 1. Adicione a plataforma em `src/platforms/registry.js`

Inclua uma nova entrada no array `PLATFORM_ADAPTERS`:

```js
{
  id: 'nova-casa',
  name: 'Nova Casa',
  hosts: ['novacasa.com'],
  status: 'beta',
  defaultSelectors: {
    price: '',
    asset: '',
    timeframe: ''
  },
  patterns: {
    price: '...',
    asset: '...',
    timeframe: '...'
  },
  patternFlags: {
    price: '',
    asset: 'i',
    timeframe: 'i'
  },
  capabilities: {
    structuredQuotes: false,
    candles: false,
    expiration: false,
    multiAsset: false
  }
}
```

`generic` existe apenas como stub de exemplo e possui `hosts: []`; ele nunca é escolhido automaticamente por `detectPlatform()`.

### 2. Libere o host no `manifest.json`

Adicione o domínio novo em `host_permissions` e nos dois blocos de `content_scripts[].matches`:

```json
"https://*.novacasa.com/*"
```

Não use `<all_urls>` só para simplificar: mantenha as permissões restritas às plataformas realmente suportadas.

### 3. Configure seletores opcionais

O painel de configurações grava overrides em:

```js
settings.selectorsByPlatform = {
  casatrade: {
    price: '.price-value',
    asset: '.asset-name',
    timeframe: '.timeframe'
  }
}
```

Se os seletores estiverem vazios, o adapter usa defaults/regex/fallbacks do registry.

## Isolamento entre plataformas

O `orchestrator` separa CandleBuilders pela chave:

```text
platformId:asset:analysisTimeframe
```

Assim, por exemplo, `casatrade:EUR/USD:M1` e `outra-casa:EUR/USD:M1` mantêm históricos independentes.

## Backend

Variáveis esperadas:

```text
PORT=8787
ATS_API_KEY=change-me
CORS_ORIGINS=chrome-extension://SEU_EXTENSION_ID,http://localhost:5500
```

Rotas protegidas por `x-api-key`:

- `POST /v1/session`
- `POST /v1/events`
- `GET /v1/admin/metrics`

`GET /health` continua público. Sem `ATS_API_KEY`, rotas protegidas retornam `503`; com chave configurada e header incorreto/ausente, retornam `401`.

## Testes

```bash
cd backend
npm test
```

Cobertura inicial:

- EMA
- RSI
- MACD
- confluence
- nextSignalState
- CandleBuilder.push
- `detectPlatform()` / registry
- isolamento de candles por `platformId`

Existe apenas um arquivo principal de testes do core: `test/core.test.mjs`.

## Instalação para teste

1. Baixe/clone o repositório.
2. Abra `chrome://extensions`.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione a pasta que contém `manifest.json`.
6. Abra a CasaTrade e recarregue a página após instalar/atualizar a extensão para que o probe entre em `document_start`.
7. Abra o Side Panel.
8. Clique em **CONECTAR SCANNER**; a extensão vincula-se à aba atual.
9. Escolha timeframe/expiração-alvo.
10. Ative o scanner e acompanhe os ativos/linhas detectados.

## Próximas etapas

1. Validar dentro da CasaTrade autenticada o formato real do feed observado e identificar qual conexão traz quotes/ticks/candles multiativo.
2. Confirmar relógio, timeframe, expiração, payout e comportamento OTC com dados reais da própria plataforma.
3. Só depois da validação elevar `structuredQuotes`, `candles`, `expiration` e `multiAsset` para `true` quando realmente suportados.
4. Transformar o catálogo de ativos observado em scanner global/ranking de oportunidades quando o feed multiativo estiver confirmado.
5. Ampliar testes do orquestrador, data quality, market regime e risk controls.
6. Persistir backend em banco e adicionar autenticação real de usuário/licença.
7. Executar backtest com train/validation/out-of-sample.
8. Executar replay e forward-test/demo por período suficiente antes de qualquer uso real.
9. Calibrar scores somente com amostra observada; score não é probabilidade garantida.
10. Integrar IA/notícias somente depois do feed e motor determinístico estarem validados.

## Limitações atuais

- Backend usa memória; sessões e eventos se perdem ao reiniciar.
- Admin Dashboard ainda é uma base de interface e não representa métricas persistidas de produção.
- Feed estruturado CasaTrade ainda não foi validado.
- Catálogo de ativos de rede é diagnóstico até a estrutura do feed ser confirmada.
- Não existe execução automática de ordens.
- Nenhuma taxa de acerto é garantida ou inferida pelos scores.

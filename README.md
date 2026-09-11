# AI Trading Scanner

Extensão Chrome/Edge Manifest V3 com arquitetura multi-plataforma para captura, normalização e análise de mercado. A CasaTrade é a primeira integração real; o core não depende dela.

## Estado atual — v0.3.0

O projeto possui:

- Side Panel com conexão, mercado atual, score, grade, estado do scanner e diagnóstico.
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

> Importante: a CasaTrade continua com `capabilities.structuredQuotes=false`. Enquanto a captura vier de DOM/regex, os candles locais são apenas provisórios e não devem ser tratados como feed estruturado da corretora.

## Arquitetura

```text
Plataforma
  ↓
Platform Registry
  ↓
Generic Content Adapter
  ↓
Snapshot normalizado
  ↓
CandleBuilder
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
src/content/    content adapter genérico
src/sidepanel/  interface principal
src/admin/      configurações locais da extensão
backend/        API Node
apps/admin-dashboard/ dashboard central
```

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

Adicione o domínio novo em três pontos:

- `host_permissions`
- `content_scripts[0].matches`
- `web_accessible_resources[0].matches`

Exemplo:

```json
"https://*.novacasa.com/*"
```

Não use `<all_urls>` só para simplificar: mantenha as permissões restritas às plataformas realmente suportadas.

### 3. Configure seletores opcionais no painel da extensão

O painel administrativo lista automaticamente todas as entradas do registry e grava overrides assim:

```js
settings.selectorsByPlatform = {
  casatrade: {
    price: '.price-value',
    asset: '.asset-name',
    timeframe: '.timeframe'
  },
  'nova-casa': {
    price: '.quote',
    asset: '.symbol',
    timeframe: '.interval'
  }
}
```

Se os seletores estiverem vazios, o adapter usa os defaults e depois os regex/fallbacks do registry.

## Isolamento entre plataformas

O `orchestrator` separa CandleBuilders pela chave:

```text
platformId:asset:timeframe
```

Assim, por exemplo, `casatrade:EUR/USD:M1` e `outra-casa:EUR/USD:M1` mantêm históricos independentes e não misturam candles, mesmo que as duas plataformas sejam usadas no mesmo navegador.

Esse comportamento possui teste unitário em `test/core.test.mjs`.

## Backend

Variáveis esperadas:

```text
PORT=8787
ATS_API_KEY=change-me
CORS_ORIGINS=chrome-extension://SEU_EXTENSION_ID,http://localhost:5500
```

Exemplo disponível em `backend/.env.example`.

Rotas protegidas por `x-api-key`:

- `POST /v1/session`
- `POST /v1/events`
- `GET /v1/admin/metrics`

`GET /health` continua público para health check. Se `ATS_API_KEY` não estiver configurada, rotas protegidas retornam `503`; com chave configurada e header incorreto/ausente, retornam `401`.

> Um segredo embutido em extensão distribuída não é autenticação forte. Em produção, use autenticação de usuário/licença e tokens curtos emitidos pelo backend.

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

O GitHub Actions também valida Manifest V3, sintaxe, arquivos obrigatórios e executa os testes.

## Instalação para teste

1. Baixe/clone o repositório.
2. Abra `chrome://extensions` no Chrome desktop.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione a pasta que contém `manifest.json`.
6. Abra uma plataforma cujo host esteja cadastrado no registry + manifest.
7. Faça login normalmente.
8. Abra o Side Panel pelo ícone da extensão.
9. Ajuste seletores específicos da plataforma, se necessário.
10. Ative o scanner.

## Próximas etapas

1. Validar o adapter dentro da CasaTrade autenticada e identificar uma fonte estruturada legítima de quotes/ticks/candles.
2. Confirmar relógio, timeframe, expiração e comportamento OTC com dados reais da própria plataforma.
3. Substituir o feed provisório baseado em DOM pela fonte estruturada validada e só então habilitar confirmações reais.
4. Ampliar testes do orquestrador, data quality, market regime e risk controls.
5. Persistir backend em banco, adicionar autenticação real de usuário/licença e proteger o dashboard administrativo.
6. Executar backtest com separação train/validation/out-of-sample.
7. Executar replay e forward-test/demo por período suficiente antes de qualquer uso real.
8. Calibrar scores somente com amostra observada; não tratar score como probabilidade de acerto.
9. Integrar camada de IA e notícias somente depois do motor determinístico e do feed estarem validados.
10. Adicionar novas plataformas exclusivamente por configuração/adapter, sem acoplar o core a uma casa específica.

## Limitações atuais

- Backend usa memória; sessões e eventos se perdem ao reiniciar.
- Admin Dashboard ainda é uma base de interface e não representa métricas persistidas de produção.
- Feed estruturado CasaTrade ainda não foi validado.
- Não existe execução automática de ordens.
- Nenhuma taxa de acerto é garantida ou inferida pelos scores.

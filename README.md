# AI Trading Scanner

Extensão Chrome/Edge Manifest V3 com arquitetura multi-plataforma para captura, normalização e análise de mercado. A CasaTrade é o primeiro adapter; o core não deve depender dela.

## Estado atual — v0.3.0

O projeto já possui:

- Side Panel com conexão, mercado atual, score, grade, estado do scanner e diagnóstico.
- Service worker em modo ES module.
- Pipeline integrado em `src/core/orchestrator.js`: snapshot → CandleBuilder → análise → confluência → quality gate → risk guard/dedupe → state machine → `scannerState.signal`.
- Indicadores centralizados em `src/core/indicators.js` (SMA, EMA, RSI, MACD, ATR e Bollinger). `analysis.js` reutiliza essa implementação e não mantém fórmulas duplicadas.
- CandleBuilder local com candles fechados imutáveis.
- Market regime, confluence, risk controls, signal state machine, replay, histórico, feature flags e demais módulos de core.
- Adapter CasaTrade com fallback por DOM e suporte a seletores CSS configuráveis em `chrome.storage.local.settings.casatradeSelectors`.
- Configurações locais para scanner, backend e seletores CasaTrade.
- Backend Node sem framework em `backend/` com `/health`, `/v1/session`, `/v1/events` e `/v1/admin/metrics`.
- Validação de payload, limite de corpo, `x-api-key` e CORS por allowlist no backend.
- Admin Dashboard separado em `apps/admin-dashboard/`.
- Testes unitários com `node:test` e CI no GitHub Actions.

> Importante: `capabilities.structuredQuotes` continua `false` no adapter CasaTrade. Os preços capturados por regex/DOM podem alimentar candles locais para diagnóstico, mas o orquestrador os marca como provisórios e bloqueia confirmação operacional até existir uma fonte estruturada e validada. Não trate esses candles como feed real da corretora.

## Arquitetura

```text
Plataforma
  ↓
Platform Adapter
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
src/platforms/  adapters e registry
src/services/   telemetria / providers
src/content/    captura dentro das plataformas
src/sidepanel/  interface principal
src/admin/      configurações locais da extensão
backend/        API Node
apps/admin-dashboard/ dashboard central
```

## CasaTrade: captura e seletores

O adapter tenta primeiro os seletores configurados e mantém regex/DOM apenas como fallback. Os seletores podem ser salvos pelo painel de configurações ou diretamente em `chrome.storage.local`:

```js
{
  settings: {
    casatradeSelectors: {
      price: '.price-value',
      asset: '.asset-name',
      timeframe: '.timeframe'
    }
  }
}
```

Quando preço, ativo ou timeframe não são encontrados, o adapter registra o problema no diagnóstico e em `console.debug`. Nenhuma senha, cookie, token de sessão ou saldo é coletado.

## Backend

Variáveis esperadas:

```text
PORT=8787
ATS_API_KEY=change-me
CORS_ORIGINS=chrome-extension://SEU_EXTENSION_ID,http://localhost:5500
```

Exemplo disponível em `backend/.env.example`.

Inicie definindo as variáveis no ambiente e depois:

```bash
cd backend
npm start
```

A extensão envia o header `x-api-key` quando `settings.backendApiKey` estiver configurado. Esse token simples é adequado para desenvolvimento/controle básico de acesso, mas não é um segredo forte em uma extensão distribuída; produção deve usar autenticação de usuário e tokens curtos emitidos pelo backend.

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

O GitHub Actions também valida Manifest V3, sintaxe do código, arquivos obrigatórios e executa os testes.

## Instalação para teste

1. Baixe/clone o repositório.
2. Abra `chrome://extensions` no Chrome desktop.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione a pasta que contém `manifest.json`.
6. Abra a CasaTrade e faça login normalmente.
7. Abra o Side Panel pelo ícone da extensão.
8. Em **Configurações**, informe seletores CasaTrade caso já tenha identificado os seletores reais.
9. Ative o scanner.

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
10. Adicionar novas plataformas por adapters independentes, sem alterar o core.

## Limitações atuais

- Backend usa memória; sessões e eventos se perdem ao reiniciar.
- Admin Dashboard ainda é uma base de interface e não representa métricas persistidas de produção.
- Feed estruturado CasaTrade ainda não foi validado.
- Não existe execução automática de ordens.
- Nenhuma taxa de acerto é garantida ou inferida pelos scores.

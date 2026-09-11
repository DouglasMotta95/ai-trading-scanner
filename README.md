# AI Trading Scanner

Extensão Chrome/Edge Manifest V3 com arquitetura multi-plataforma para captura, normalização e análise de mercado. A CasaTrade é a primeira integração real; o core não depende dela.

## Estado atual — v0.4.0

O projeto possui:

- Side Panel com layout de terminal, vínculo à aba ativa, mercado em foco, score, warmup, catálogo de ativos, timeframe/expiração e handoff de compra/venda.
- Investigador de feed em `src/content/network-probe.js` para observar WebSocket/fetch/XHR recebidos pela própria página, sem coletar cookies, headers, corpo de requisição, query string ou campos de autenticação/sessão.
- Fallback DOM em `src/content/generic-adapter.js`, inclusive ativos visíveis, expiração e tipos Blitz/Binária/Turbo/CFD quando aparecem no texto da página.
- Timeframes curtos `S5`, `S15`, `S30` além de M1/M5/M15/M30/H1/H4.
- Pipeline `snapshot → CandleBuilder → análise → confluence → quality gate → risk controls → state machine`.
- Pré-sinal provisório quando a leitura técnica existe, mas o feed estruturado da plataforma ainda não foi validado. Confirmação operacional continua bloqueada até a qualidade necessária ser atendida.
- Sistema de licenciamento com planos, limite diário de sinais e limite de dispositivos.
- Admin Central para gerar/revogar licenças, ver clientes online, consumo e métricas reais.
- Backend Node sem framework, com validação, CORS allowlist, `x-api-key` técnico e `x-admin-key` separado.
- Testes com `node:test` e CI no GitHub Actions.

> Importante: `0 de 6` no card de sinal significa **critérios técnicos confirmados**, não limite de entradas do plano. O limite diário comercial aparece separadamente no card **Plano e consumo**.

> A CasaTrade continua com `structuredQuotes=false` até o feed real ser validado. DOM e tráfego ainda não confirmado podem gerar diagnóstico/pré-sinal, mas não devem ser tratados como confirmação real.

## Arquitetura

```text
Plataforma aberta na aba atual
  ↓
Platform Registry
  ↓
Network Probe + Generic Adapter
  ↓
Catálogo / Snapshot normalizado
  ↓
CandleBuilder por platformId:asset:timeframe
  ↓
Analysis / Indicators
  ↓
Confluence + Market Regime
  ↓
Quality Gate + Risk Controls + Licença/Quota
  ↓
Signal State Machine
  ↓
Side Panel
```

Pastas principais:

```text
src/core/                 lógica pura e orquestração
src/platforms/            registry e adapters
src/services/             licença, telemetria e providers
src/content/              captura e diagnóstico de rede
src/sidepanel/            terminal principal
src/admin/                configurações locais da extensão
backend/                  API Node + persistência local de licenças
apps/admin-dashboard/     Admin Central
```

## Por que o scanner pode ficar em “analisando”

O motor precisa formar histórico suficiente. O Side Panel mostra o aquecimento como `X / 21 candles`. Antes disso ele fica em `ANALISANDO MERCADO` em vez de mostrar um falso `NO_TRADE`.

Depois do warmup, se houver confluência técnica mas a fonte ainda for provisória, o estado pode virar `SETUP EM FORMAÇÃO / PRÉ-SINAL PROVISÓRIO`. A confirmação final só é liberada quando a qualidade do feed e os demais guards estiverem válidos.

## Timeframe e expiração

Timeframe de análise e expiração da operação são campos separados. Exemplos:

```text
Análise: S5 / S15 / S30 / M1 / M5 / M15
Expiração: 5s / 15s / 30s / 60s / 2m / 5m
```

O modo `AUTO` usa o que for detectado na própria plataforma.

## Licenciamento e planos

O backend possui planos iniciais configuráveis por variável de ambiente:

```text
trial      3 sinais/dia   1 dispositivo
starter    6 sinais/dia   1 dispositivo
pro       20 sinais/dia   2 dispositivos
unlimited sem limite      5 dispositivos
```

Esses valores são defaults técnicos e podem ser alterados sem mudar a extensão usando:

```text
PLAN_TRIAL_SIGNALS
PLAN_STARTER_SIGNALS
PLAN_PRO_SIGNALS
PLAN_PRO_DEVICES
PLAN_UNLIMITED_DEVICES
```

A extensão valida a licença no backend e atualiza presença do dispositivo. Quando um novo `CONFIRM` é realmente liberado, o backend consome 1 sinal do limite diário do plano. Se o limite acabar, novos sinais confirmados ficam bloqueados até a próxima virada de dia.

Build descompactada/local permanece em modo de desenvolvimento para não travar os testes. Uma distribuição de produção deve usar `licenseRequired=true` e backend configurado.

## Admin Central

O dashboard central agora é servido pelo próprio backend.

```bash
cd backend
ATS_API_KEY=dev-api ATS_ADMIN_KEY=dev-admin CORS_ORIGINS=chrome-extension://SEU_ID npm start
```

Abra:

```text
http://localhost:8787/admin
```

No painel, informe:

- Backend: `http://localhost:8787`
- Chave Admin: o valor de `ATS_ADMIN_KEY`

O Admin Central permite:

- gerar licença;
- escolher plano e validade;
- revogar/reativar licença;
- ver uso diário;
- ver dispositivos/clientes online;
- ver versão e métricas reais.

As licenças são persistidas localmente em `backend/data/licenses.json`, que não é versionado no GitHub. Para produção SaaS, o próximo passo é trocar esse arquivo por banco de dados.

## Backend

Exemplo de ambiente:

```text
PORT=8787
ATS_API_KEY=change-me
ATS_ADMIN_KEY=change-admin-me
CORS_ORIGINS=chrome-extension://SEU_EXTENSION_ID,http://localhost:5500
PLAN_TRIAL_SIGNALS=3
PLAN_STARTER_SIGNALS=6
PLAN_PRO_SIGNALS=20
PLAN_PRO_DEVICES=2
PLAN_UNLIMITED_DEVICES=5
```

Rotas técnicas protegidas por `x-api-key`:

```text
POST /v1/session
POST /v1/events
```

Rotas administrativas protegidas por `x-admin-key`:

```text
GET  /v1/admin/metrics
GET  /v1/admin/plans
GET  /v1/admin/licenses
POST /v1/admin/licenses
GET  /v1/admin/clients
POST /v1/admin/licenses/:key/revoke
POST /v1/admin/licenses/:key/activate
```

Rotas de licença usadas pela extensão:

```text
POST /v1/license/activate
POST /v1/license/validate
POST /v1/license/consume
```

## Compra e venda

Os botões da extensão fazem handoff seguro: focam a aba da corretora, localizam o controle correspondente e o destacam. A ordem financeira não é enviada automaticamente; a confirmação final continua na própria plataforma.

## Como cadastrar uma nova plataforma

1. Adicione uma entrada em `src/platforms/registry.js` com `id`, `name`, `hosts`, seletores/patterns e capabilities.
2. Adicione o host em `host_permissions` e nos dois blocos `content_scripts[].matches` do `manifest.json`.
3. Se necessário, configure seletores específicos em `settings.selectorsByPlatform[platformId]` nas Configurações da Extensão.

O `orchestrator` separa histórico por `platformId:asset:analysisTimeframe`, portanto casas diferentes nunca compartilham CandleBuilder.

## Testes

```bash
cd backend
npm test
```

Cobertura atual inclui EMA, RSI, MACD, confluence, state machine, CandleBuilder, registry e isolamento entre plataformas.

## Instalação para teste

1. Baixe/clone o repositório.
2. Abra `chrome://extensions`.
3. Ative Modo do desenvolvedor.
4. Carregue a pasta que contém `manifest.json`.
5. Abra a CasaTrade e recarregue a página para o probe entrar desde `document_start`.
6. Abra o Side Panel e clique em **CONECTAR SCANNER**.
7. Inicie a leitura e acompanhe o warmup, ativos e pré-sinais.

## Próximas etapas

1. Validar o formato real do feed CasaTrade autenticado e identificar quotes/ticks/candles multiativo.
2. Confirmar relógio, payout, expiração e OTC com dados reais.
3. Elevar capabilities para `true` apenas quando cada fonte estiver comprovada.
4. Trocar persistência local de licenças por banco de dados e autenticação de usuário/licença em produção.
5. Executar backtest, replay e forward-test/demo antes de qualquer uso real.
6. Calibrar scores com amostra observada; score não é probabilidade garantida.

## Limitações atuais

- Sessões/eventos continuam em memória e zeram ao reiniciar o backend.
- Licenças usam arquivo JSON local; adequado para desenvolvimento, não para produção distribuída.
- Feed estruturado CasaTrade ainda não foi validado.
- Não existe execução automática de ordens.
- Nenhuma taxa de acerto é garantida ou inferida pelos scores.

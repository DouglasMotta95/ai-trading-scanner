# AI Trading Scanner

Extensão Chrome/Edge Manifest V3 com arquitetura multi-plataforma para captura, normalização e análise de mercado. A CasaTrade é a primeira integração real; o motor de análise continua independente da plataforma.

## Estado atual — extensão v0.9.6

A experiência principal está em português e segue o fluxo comercial:

1. **Configuração da operação** — valor, tempo da vela e expiração.
2. **Sincronização com a CasaTrade** — o ATS tenta aplicar a configuração e lê os controles de volta.
3. **Mercado em foco** — ativo, cotação, tipo de instrumento, OTC/regular, vela, expiração, fonte e qualidade do feed.
4. **Decisão do scanner** — aguardando, observando, não entrar ou entrada confirmada.
5. **Entrada** — fica imediatamente abaixo do sinal e somente a direção confirmada é liberada.
6. **Inteligência de mercado** — ranking automático dos mercados observados, usando confluência quantitativa e contexto de sessão.
7. **Todos os mercados** — catálogo combinado de ativos encontrados no DOM e no WebSocket.

> Regra de segurança: o ATS não trata o valor escolhido no painel como se já estivesse configurado na CasaTrade. Depois de tentar aplicar valor, vela e expiração, ele lê a plataforma novamente. Se não conseguir confirmar os três valores, a análise principal fica bloqueada/pausada.

## Detecção CasaTrade

`src/platforms/registry.js` mantém a configuração por plataforma. A CasaTrade possui candidatos de seletores para ativo, preço, timeframe, expiração e valor, além de padrões para pares convencionais, OTC e símbolos compactos.

`src/content/generic-adapter.js` usa essas informações com fallback semântico. Ele procura elementos visíveis e selecionados, abas/roles, elementos ativos, texto comum e `svg text`. O gráfico pode ser canvas sem texto interno; nesse caso o contexto do ativo vem dos controles/abas da plataforma e o preço deve vir preferencialmente do feed de rede.

A normalização procura representar pares no formato legível, por exemplo:

```text
EURUSD_otc → EUR/USD (OTC)
EUR-USD     → EUR/USD
```

O tipo de instrumento é classificado quando a página/feed expõe informações legíveis como `Blitz`, `Binária`, `Turbo` ou `CFD`.

## WebSocket e feed estruturado

`src/content/network-probe.js` observa as respostas de mercado que a própria página já recebe. O parser suporta JSON direto, mensagens WebSocket em Blob/ArrayBuffer, frames comuns de Socket.IO, linhas `data:` e estruturas aninhadas.

Ele tenta extrair e normalizar:

```text
asset / symbol / instrument
price / bid / ask
open / high / low / close
timeframe / interval
expiration / expiry
timestamp
payout
tipo de instrumento
flag de ativo selecionado
```

Cada candidato recebe evidências de repetição, recência e confiança. O adapter só promove uma cotação para `structuredQuotes=true` quando existe candidato recente, repetido e compatível com o ativo em foco. WebSocket é priorizado quando disponível; DOM continua como fallback.

O probe também mantém histórico OHLC observado por ativo. Quando esse histórico existe, ele alimenta `CandleBuilder.seed(...)`; candles ausentes não são inventados.

## Todos os mercados / multiativo

O catálogo combina ativos detectados no DOM com ativos recebidos no feed de rede. O `background-augment.js` analisa candidatos estruturados por ativo e mantém `universeAnalysis` e `universeRecommendation`.

Esse radar roda automaticamente quando existe licença ativa e dados disponíveis, sem consumir um sinal comercial apenas por estar classificando mercados. A execução/entrada continua separada e sujeita aos guards do scanner principal.

## Inteligência de mercado e IA

A v0.9.6 possui uma camada automática de **inteligência local**, não uma integração externa de IA fingida. Ela classifica os mercados observados usando:

- score e estado técnico do motor;
- feed estruturado;
- histórico real disponível;
- contexto aproximado de sessão (Ásia, Londres e Nova York) para pares não-OTC;
- contexto específico de OTC, que não é tratado como se seguisse a sessão oficial do par.

O painel mostra os melhores candidatos automaticamente depois que a extensão conecta e recebe dados.

`marketIntelligence.externalAi = "nao_configurada"` é intencional. Para integrar um modelo externo e notícias/calendário ao vivo, é necessário escolher o provedor e configurar a credencial **somente no backend**. Nenhuma chave de IA deve ser embutida na extensão. Até existir esse provedor, o ATS não inventa notícias, sentimento ou respostas de IA.

## Fonte de verdade: CasaTrade

O fluxo de configuração é:

```text
Configuração escolhida no ATS
  ↓
ATS tenta aplicar Valor + Vela + Expiração na CasaTrade
  ↓
ATS lê os controles reais da CasaTrade de volta
  ↓
Só considera sincronizado se os 3 valores coincidirem
  ↓
Somente então permite iniciar a análise principal
```

`src/content/platform-sync.js` procura controles visíveis por contexto semântico e exclui explicitamente controles financeiros de compra/venda. Se não conseguir localizar e confirmar algum controle, falha de forma segura.

## Critério técnico atual

Depois de existir histórico suficiente, o motor avalia direção quantitativa, EMA 9 x EMA 21, RSI 14, MACD, regime de mercado e força quantitativa. A confluência gera score e grade. O estado `CONFIRM` continua exigindo direção válida, score forte e feed aprovado pelos guards.

Os indicadores usam histórico suficiente e o motor também resume as últimas até 5 velas fechadas para explicar o movimento recente. Score não é probabilidade garantida de acerto.

## Timeframes e expiração

```text
Vela / análise:
S5, S15, S30, M1, M2, M5, M15, M30

Expiração:
5s, 15s, 30s, 60s, 2m, 5m
```

O painel mostra como **vela real** e **expiração real** os valores lidos da plataforma, não apenas os valores escolhidos localmente.

## Compra e venda

A extensão continua em confirmação manual. Quando existe um `CONFIRM` válido, feed aprovado e configuração sincronizada, somente o botão correspondente é liberado:

```text
COMPRA confirmada → libera COMPRA
VENDA confirmada  → libera VENDA
sem confirmação   → os dois permanecem bloqueados
```

O handoff foca a aba da CasaTrade, localiza e destaca o controle correspondente. **A extensão não executa o clique financeiro final nesta versão.**

## Privacidade

O investigador de feed observa somente respostas entregues à própria página. Ele não coleta cookies, headers de autenticação, corpos de requisição, bearer tokens, passwords ou campos de sessão. Campos com nomes relacionados a autenticação/segredo são ignorados.

## Licença

Licenciamento comercial é obrigatório também em builds descompactadas. A extensão mantém localmente o último estado válido e revalida em segundo plano. Uma falha temporária de rede/backend não transforma automaticamente uma licença válida em “Ativação necessária”; respostas autoritativas de expiração, bloqueio ou licença inexistente continuam invalidando o acesso.

## Arquitetura

```text
CasaTrade / outra plataforma
  ↓
Platform Registry
  ↓
Network Probe + DOM Adapter + Platform Sync
  ↓
Catálogo / histórico / snapshot normalizado
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
Side Panel + Radar / Inteligência local
```

Pastas principais:

```text
src/core/                 lógica pura e orquestração
src/platforms/            registry e configuração por plataforma
src/services/             licença e telemetria
src/content/              captura, sincronização e diagnóstico
src/sidepanel/            terminal principal
src/admin/                configurações locais da extensão
backend/                  API Node e licenciamento
apps/admin-dashboard/     painel administrativo
apps/customer-portal/     site público e conta do cliente
```

## Como testar

1. Baixe ou clone o repositório.
2. Abra `chrome://extensions` e ative o modo do desenvolvedor.
3. Carregue a pasta que contém `manifest.json` ou recarregue a extensão existente.
4. Recarregue também a CasaTrade para o probe entrar desde `document_start`.
5. Abra o Side Panel e conecte a conta/licença.
6. Com a aba da CasaTrade ativa, o ATS tenta conectar automaticamente; o botão manual continua disponível.
7. Escolha valor, vela e expiração e confira o status **CasaTrade sincronizada**.
8. No card Mercado em foco, valide ativo, tipo/OTC, preço, vela real, expiração real, fonte e qualidade.
9. Aguarde o catálogo e a Inteligência de mercado listarem os ativos observados.
10. Somente quando existir `CONFIRM` válido o botão de COMPRA ou VENDA correspondente será liberado.

## Testes automatizados

```bash
cd backend
npm test
```

O CI valida Manifest V3, sintaxe, Side Panel único, captura/sincronização, persistência de licença, ausência dos overlays antigos e testes do produto.

## Limitações e calibração

A CasaTrade pode alterar DOM, classes e formato das mensagens de rede. Por isso a captura usa múltiplas evidências e falha de forma segura quando não consegue provar o dado. A v0.9.6 melhora fortemente a descoberta, mas **o formato exato de uma sessão autenticada da CasaTrade ainda precisa ser validado em teste real**. Se algum controle/feed não for reconhecido, o diagnóstico deve ser usado para calibrar o adapter; não se deve inventar um seletor ou marcar feed como estruturado sem evidência.

A inteligência de mercado atual é local/quantitativa. Notícias em tempo real, calendário econômico e análise por modelo externo permanecem pendentes até a escolha/configuração de um provedor backend.

Nenhuma taxa de acerto é garantida. Antes de uso real, faça demo/forward-test com amostra suficiente.

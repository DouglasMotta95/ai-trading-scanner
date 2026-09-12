# AI Trading Scanner

Extensão Chrome/Edge Manifest V3 com arquitetura multi-plataforma para captura, normalização e análise de mercado. A CasaTrade é a primeira integração real; o motor de análise continua independente da plataforma.

## Estado atual — extensão v0.9.5

A experiência principal da extensão está em português e foi organizada para uso comercial:

1. **Configuração da operação** — valor, tempo da vela e expiração.
2. **Confirmação na CasaTrade** — a extensão tenta aplicar a configuração na plataforma e lê os controles de volta.
3. **Mercado em foco** — ativo, cotação, vela e expiração observados na plataforma.
4. **Decisão do scanner** — aguardando, observando, não entrar ou entrada confirmada.
5. **Entrada na plataforma** — fica logo abaixo do sinal; somente a direção confirmada é liberada.
6. Detalhes técnicos, histórico, licença e radar ficam abaixo como informação secundária.

> Regra de segurança: o ATS não trata o valor escolhido no painel como se ele já estivesse configurado na CasaTrade. Depois de tentar aplicar valor, vela e expiração, ele lê a plataforma novamente. Se não conseguir confirmar os três valores, a análise fica bloqueada/pausada em vez de assumir que deu certo.

## Fonte de verdade: CasaTrade

O campo de **Valor** deixou de ser um valor independente sem sincronia. A implementação usada é:

```text
Configuração escolhida no ATS
  ↓
ATS tenta aplicar Valor + Vela + Expiração na CasaTrade
  ↓
ATS lê os controles reais da CasaTrade de volta
  ↓
Só considera sincronizado se os 3 valores coincidirem
  ↓
Somente então permite iniciar a análise
```

Essa abordagem foi usada porque o seletor DOM oficial/estável da CasaTrade ainda não foi fornecido. Em vez de inventar um seletor fixo, `src/content/platform-sync.js` procura controles visíveis pelo contexto semântico (`Valor`, `Expiração`, vela/timeframe), roles e opções exibidas. A rotina exclui explicitamente controles financeiros de compra/venda e **falha de forma segura**: se não conseguir localizar e confirmar um controle, não libera a leitura.

Os valores efetivamente lidos da CasaTrade ficam visíveis no painel como:

- Valor na CasaTrade
- Vela na CasaTrade
- Expiração na CasaTrade

Assim fica claro quando a plataforma e o ATS estão ou não alinhados.

## Leitura real do mercado

O scanner não deve criar candles históricos fictícios. O fluxo atual é:

```text
CasaTrade autenticada
  ↓
WebSocket / fetch / XHR já recebidos pela própria página
  ↓
Network Probe sanitizado
  ↓
ativo + cotação + OHLC/timestamp quando existirem no feed
  ↓
histórico real observado
  ↓
CandleBuilder.seed(...)
  ↓
análise quantitativa
```

`src/content/network-probe.js` procura estruturas de preço e OHLC que já chegaram à página e mantém histórico recente por ativo. Se o feed disponibilizar candles com ativo + OHLC + timestamp de forma legível, esse histórico é usado para aquecer o motor imediatamente. Se não houver histórico utilizável no feed, o ATS continua construindo candles a partir das cotações recebidas; ele não preenche os candles que faltam artificialmente.

Para considerar uma cotação **estruturada**, o ATS exige uma observação recente e repetida do mesmo ativo em WebSocket/fetch/XHR. O `history-adapter.js` valida o ativo em foco contra essa cotação antes de promover `structuredQuotes=true`.

## Últimas velas e contexto recente

Os indicadores continuam usando histórico suficiente para evitar uma decisão baseada em poucas amostras. Quando existe histórico real, o motor também resume as **últimas até 5 velas fechadas**, mostrando quantas foram de alta e quantas de baixa. Esse contexto recente aparece para explicar o movimento atual, mas não substitui sozinho os filtros técnicos nem inventa um sinal.

## Critério técnico atual

Depois de existir histórico suficiente, o motor avalia:

- direção quantitativa;
- EMA 9 x EMA 21;
- RSI 14;
- MACD;
- regime de mercado;
- força quantitativa.

A confluência gera score e grade. A máquina de estados usa os estados `SEARCHING`, `WATCH`, `WAIT`, `CONFIRM`, `NO_TRADE`, entre outros. O estado `CONFIRM` continua exigindo direção válida, score forte e feed aprovado pelos guards. Score não é probabilidade garantida de acerto.

## Timeframes e expiração

A extensão suporta, entre outros:

```text
Vela / análise:
S5, S15, S30, M1, M2, M5, M15, M30

Expiração:
5s, 15s, 30s, 60s, 2m, 5m
```

`M2` foi adicionado porque esse período aparece na operação mostrada da CasaTrade. O ATS mostra como **vela real** e **expiração real** os valores lidos de volta da plataforma, não apenas o que foi selecionado no painel.

## Compra e venda

A extensão continua em confirmação manual. Quando há um `CONFIRM` válido e a configuração está sincronizada, somente o botão correspondente ao sinal é liberado:

```text
COMPRA confirmada → libera PREPARAR COMPRA
VENDA confirmada  → libera PREPARAR VENDA
sem confirmação   → os dois permanecem bloqueados
```

O handoff foca a aba da CasaTrade, localiza e destaca o controle correspondente. **A extensão não executa o clique financeiro final nesta versão.**

## Arquitetura

```text
Plataforma aberta na aba atual
  ↓
Platform Registry
  ↓
Network Probe + DOM Adapter + Platform Sync
  ↓
Snapshot / histórico real normalizado
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
Side Panel em português
```

Pastas principais:

```text
src/core/                 lógica pura e orquestração
src/platforms/            registry e adapters
src/services/             licença e telemetria
src/content/              captura, sincronização e diagnóstico da plataforma
src/sidepanel/            terminal principal
src/admin/                configurações locais da extensão
backend/                  API Node e licenciamento
apps/admin-dashboard/     painel administrativo
apps/customer-portal/     site público e conta do cliente
```

## Privacidade da captura

O investigador de feed observa somente dados que a própria página já recebeu. Ele foi construído para não coletar cookies, headers de autenticação, corpos de requisição, query strings, passwords, bearer tokens ou campos de sessão. As chaves que tenham nomes relacionados a autenticação/segredo são ignoradas.

## Licença

Licenciamento comercial é obrigatório também em builds descompactadas. A extensão mantém localmente o último estado de licença válido e revalida em segundo plano. Uma falha temporária de rede/backend não transforma automaticamente uma licença válida em “Ativação necessária”; respostas autoritativas de expiração, bloqueio ou licença inexistente continuam invalidando o acesso.

## Instalação para teste

1. Baixe ou clone o repositório.
2. Abra `chrome://extensions`.
3. Ative **Modo do desenvolvedor**.
4. Use **Carregar sem compactação** na pasta que contém `manifest.json`.
5. Abra a CasaTrade e recarregue a página para os content scripts entrarem desde o início.
6. Abra o Side Panel.
7. Conecte sua conta/licença.
8. Escolha valor, vela e expiração.
9. Clique em **CONECTAR CASATRADE**.
10. Confirme que o card informa **CasaTrade sincronizada** antes de iniciar a análise.

## Como cadastrar uma nova plataforma

1. Adicione a plataforma em `src/platforms/registry.js` com `id`, `name`, hosts, padrões/seletores e capabilities.
2. Adicione os hosts necessários no `manifest.json`.
3. Implemente apenas os controles específicos que forem realmente necessários no adapter da plataforma.
4. Mantenha o motor quantitativo independente da corretora.

## Testes

```bash
cd backend
npm test
```

O CI também valida sintaxe dos módulos da extensão, presença do Side Panel único, persistência de licença, sincronização dos controles da plataforma e ausência do antigo `preflight.js` duplicado.

## Limitações que ainda exigem teste autenticado

A CasaTrade pode alterar DOM, nomes de classes ou formato das mensagens de rede. Por isso, a sincronização de valor/vela/expiração usa detecção semântica e readback, e bloqueia a análise quando não consegue comprovar o alinhamento. A captura de histórico acelera o aquecimento apenas quando OHLC/timestamp reais estão disponíveis no tráfego observado. Esses pontos precisam ser validados na sessão autenticada real depois de cada mudança relevante da plataforma.

Nenhuma taxa de acerto é garantida. Antes de uso real, o motor deve ser acompanhado em demo/forward-test com dados suficientes.

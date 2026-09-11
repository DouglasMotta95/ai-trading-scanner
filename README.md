# AI Trading Scanner

Extensão Chrome/Edge Manifest V3 para diagnóstico e análise da plataforma CasaTrade.

## Estado atual — v0.1.0

Primeira base funcional criada do zero:

- Side Panel premium com animações de conexão, radar e estados online/offline.
- Botão Conectar Scanner com procura real por abas CasaTrade.
- Content script dedicado à CasaTrade.
- Detecção inicial de ativo, timeframe, candidatos de preço e elementos de gráfico no DOM.
- Heartbeat entre a página, service worker e painel.
- Estado persistente em `chrome.storage.local`.
- Ativar/pausar scanner.
- Nenhuma senha, cookie ou token de autenticação é coletado.

> Esta build é de diagnóstico. A detecção de preço/ativo/timeframe ainda precisa ser validada na plataforma autenticada antes de ser usada pelo motor de sinais.

## Instalação para teste

1. Baixe/clone este repositório.
2. Abra `chrome://extensions` no Chrome desktop.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione a pasta deste repositório.
6. Abra a CasaTrade e faça login normalmente.
7. Clique no ícone da extensão. O Side Panel abrirá.
8. Clique em **CONECTAR SCANNER**.

## Próximas etapas

1. Validar seletores reais da CasaTrade e identificar a fonte estruturada de candles/ticks.
2. Criar coletor OHLC/tick com sincronização de relógio.
3. Motor quantitativo e máquina de estados WATCH/WAIT/CONFIRM/CANCEL/NO_TRADE.
4. Mini-chart, confluências, regime, multi-timeframe e histórico imutável.
5. Backend e camada AI provider (OpenAI/Gemini) sem expor chaves na extensão.
6. Backtest, replay e forward-test/demo antes de qualquer uso real.

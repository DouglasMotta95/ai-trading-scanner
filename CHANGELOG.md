# Changelog

## 0.11.75 — visual fallback sem dependência circular + ativos nomeados

### Diagnóstico que motivou a correção
- No diagnóstico ao vivo fornecido para o caso USD/HKD, havia 7.000+ mensagens de rede recebidas, mas o network-probe não conseguia obter um ativo utilizável quando o focused-asset-v2 estava bloqueado.
- A causa observada foi uma dependência circular no fallback: o network-probe pedia um nome visual, mas o focused-asset-v2 só respondia quando já tinha reliable === true. Portanto, exatamente no cenário em que o fallback era necessário, nenhuma resposta era devolvida.
- O reconhecimento de rede também estava limitado ao formato BASE/QUOTE. Ativos nomeados, como ações e commodities/índices, não passavam por esse parser mesmo quando o nome aparecia claramente no payload.
- O diagnóstico do focused reader agora registra, mesmo sem reliable=true, o último winner.asset bruto, estado de bloqueio/motivo, contagem de candidatos de texto encontrados no DOM/shadow DOM e se houve algum texto candidato.

### Correções
- O focused-asset-v2 responde ao pedido de fallback com o melhor candidato bruto da varredura mais recente, marcando explicitamente o payload como baixa confiança quando ele ainda não é autoridade.
- O network-probe passa a receber essa informação sem depender de reliable=true; a confiança permanece explícita e não altera os gates de segurança da decisão final.
- O parser de rede passa a reconhecer, de forma conservadora, instrumentos nomeados sem formato BASE/QUOTE, reaproveitando as mesmas regras de limpeza/rejeição de tokens genéricos usadas pelo focused reader.
- A correção cobre exemplos como Coca-Cola, Melamina e McDonald's, além de pares exóticos como USD/HKD.
- Corrigida também a referência ausente a INSTRUMENT_WORDS no parser de instrumentos nomeados do focused-asset-v2.
- Score, perfis, filtros sombra, relógio, licença, Gemini e execução manual não foram alterados.

### Arquivos alterados
- src/content/focused-asset-v2.js
- src/content/network-probe.js
- src/background-control.js
- src/sidepanel/ui-shell-v2.js
- manifest.json
- package.json
- CHANGELOG.md

## 0.11.25 — Expiration authority hotfix

### Problema real corrigido
- A build 0.11.24 ainda podia abrir o painel e acusar falha de expiração mesmo com a CasaTrade já em 1 minuto.
- O erro vinha de três pontos combinados: dependência excessiva de texto DOM, cache antigo com confiança alta bloqueando leitura nova e timeout herdado de uma sessão antiga ao reabrir o painel.

### Correções
- Expiração passa a ser lida por múltiplas fontes independentes:
  - DOM/atributos do controle visível;
  - formatos adicionais como `00:01:00`, `1m00s`, `data-value="60"` e `aria-valuenow="60"`;
  - feed/rede da CasaTrade quando uma chave semântica de expiração/duração de operação é encontrada.
- A rede publica uma autoridade separada de expiração em `ATS_PLATFORM_CONTROLS_OBSERVED` com fonte `casatrade-network-control`.
- Uma leitura nova e fresca pode substituir cache antigo de maior score.
- O timeout de expiração começa na abertura atual do painel, evitando erro instantâneo por sessão velha.
- Ao abrir o painel, os leitores são reinjetados silenciosamente na `targetTabId` CasaTrade registrada, sem reconectar ou limpar a aba ativa.
- O gate manual usa freshness específica da expiração, não o timestamp genérico de outros controles.

### Teste específico
- `test/expiration-panel-open-regression.test.mjs` cobre:
  - atributos de controles customizados;
  - fallback de rede;
  - substituição de cache stale;
  - janela nova de leitura ao abrir o painel;
  - reinjeção na aba CasaTrade registrada;
  - freshness específica no gate final.

## 0.11.24 — Live asset switch + expiration v2

### 1. Troca de ativo atômica
- A troca de instrumento agora zera preço, OHLC, velas, histórico, sinal, decisão profissional, auditoria Gemini e dados operacionais antes de aceitar a nova sessão.
- O novo nome não é publicado como mercado ao vivo até que preço + histórico do mesmo instrumento passem pela validação de identidade.
- `marketSession` ganhou `pendingAsset`, `confirmedAsset`, `dataReady` e `transitioning`.
- Feeds atrasados do ativo anterior são rejeitados por identidade e por sanity check de escala entre preço e histórico.
- Preço avulso do gráfico só é aceito depois que a sessão do novo ativo já foi confirmada por feed + candles.
- Seleção explícita/estável de um novo ativo pode substituir um foco antigo mesmo quando a autoridade muda de frame.
- Teste principal: `test/video-14756-v2-regression.test.mjs`, cenário **“five rapid asset switches cannot mix previous asset identity or price scale”**. Ele simula 5 trocas rápidas entre ETH/USD OTC, AUD/CAD OTC, BTC/USD OTC e EUR/USD OTC e tenta contaminar o novo ativo com identidade/preço do anterior.

### 2. Expiração real
- A freshness da expiração passou a ser independente de timeframe/outros controles: um heartbeat de outro campo não renova mais uma expiração antiga.
- O probe busca `Expiração` em sibling, parent, children, `aria-controls`, shadow roots, proximidade visual e body text.
- O probe tem fallback direto para `chrome.runtime.sendMessage` e não morre se o helper de mensagens não estiver disponível.
- Estado nulo segue a sequência: `LENDO…` → após timeout, `ERRO / Não foi possível ler a expiração`.
- A mensagem `ALTERE PARA 1 MIN` só aparece quando um valor real fresco foi lido e é diferente de 60 s.
- Quando 60 s é lido, a UI mostra `1 min ✓`.

### 3. Countdown exato x estimado
- Countdown exato é identificado como `REAL / EXATO • CASATRADE`.
- Fallback operacional é identificado com `~` e `ESTIMADO`; nunca se apresenta como exato.
- A UI aplica suavização para impedir queda visual superior a 1 segundo em menos de 1,5 s.
- A chave de suavização é estável por ciclo e preserva o rollover da vela.

### 4. Status de conexão
- Removido o badge duplicado do cabeçalho.
- O botão permanece como indicador único de conexão.
- Durante troca de ativo a CasaTrade continua `CONECTADA`; a UI mostra `ATUALIZANDO PARA {ativo}` em vez de simular desconexão.

### 5. Histerese do padrão técnico
- Mudanças BUY ↔ SELL não substituem o padrão imediatamente.
- A nova direção precisa de leituras consecutivas/sustentadas antes de assumir o veredito.
- Durante a mudança, a UI mostra `PADRÃO MUDANDO — REAVALIANDO` com direção anterior e nova.

### 6. Funil de sinal
- O motor técnico continua com owner único em `background.js`.
- Um padrão válido permanece visível como `POSSÍVEL COMPRA/VENDA` mesmo quando a entrada final está bloqueada por expiração/timeframe.
- `ENTRAR` continua exigindo clock exato + M1 + expiração real de 60 s + confirmação técnica.
- Bloqueios de leitura não apagam silenciosamente o candidato técnico.

### 7. Fonte/confiança do dado
- ATIVO, EXPIRAÇÃO e VELA exibem `REAL`, `ESTIMADO`, `ATUALIZANDO` ou `STALE`.
- A UI informa se o countdown veio diretamente da CasaTrade ou de fallback temporário.

### 8. Log de troca de ativo
- Diagnóstico mantém as últimas 12 trocas com timestamp, ativo anterior, novo ativo, epoch, origem e resultado da limpeza.
- O log é exibido apenas em `AVANÇADO`.

### 9. Timeouts visíveis
- Expiração ausente muda de `LENDO…` para erro explícito após 5 s.
- Transição de ativo prolongada mostra botão `TENTAR NOVAMENTE`.
- O botão de recovery também aparece para falha de leitura da expiração.

### 10. Bloqueio por regra x falha técnica
- Bloqueio por estratégia (ex.: expiração real 5 s) possui mensagem/estilo próprio.
- Falha técnica (ex.: expiração não lida ou countdown ausente) possui mensagem/estilo distinto.
- A UI não manda o usuário alterar um controle que a extensão não conseguiu ler.

### 11. Ativo esperado
- Adicionada preferência opcional `Ativo esperado` em Avançado.
- Ao mudar para outro instrumento, a UI alerta qual ativo foi selecionado e qual era o esperado, sem impedir a análise automaticamente.

### Testes e aceite
- Novo arquivo: `test/video-14756-v2-regression.test.mjs`.
- Cobre: 5 trocas rápidas, contaminação cross-asset, reset atômico, freshness da expiração, ausência de falso “altere para 1 min”, suavização/rotulagem do countdown, badge único, histerese BUY/SELL, POSSÍVEL com execution gate, fontes de dados, recovery, log e ativo esperado.
- A validação ao vivo continua obrigatória para confirmar DOM/frames/WebSocket reais da CasaTrade, especialmente troca de ativo, leitura do seletor de expiração e três rollovers M1 consecutivos.

## 0.11.23 — CasaTrade live acceptance stabilization

### 1. Detecção do ativo ativo
- Mantida a identidade canônica com OTC separado do mercado normal.
- O foco visual usa seleção explícita, interação recente e cabeçalho do gráfico; itens soltos de watchlist/dropdown não podem assumir o foco.
- Troca real de ativo limpa sessão, histórico, OHLC/sinal anterior e força nova aquisição antes de analisar o novo instrumento.
- Teste: `video-14668-acceptance-regression.test.mjs` valida observer, OTC e reset de sessão.

### 2. Handshake de conexão
- Timeout explícito de 7 s: falha vira `handshake_timeout` / `Falha ao conectar — tentar novamente.`.
- Badge estável reduzido a `CONECTADO` ou `DESCONECTADO`.
- Corrigido nesta versão: conexão não depende mais de já ter 10 velas nem de a expiração estar correta. Esses itens são readiness da estratégia, não handshake de transporte.
- A conexão exige ativo confiável, preço e countdown real/fresco da CasaTrade.
- Teste: handshake sem dependência de histórico/expiração e timeout explícito.

### 3. Countdown da vela
- Countdown e expiração permanecem canais independentes.
- O clock exato aceita apenas fontes autoritativas da CasaTrade para liberar entrada.
- Rollover M1 protege a transição `2 → 1 → 59/60` e impede o valor antigo de 1 s de vencer o novo ciclo.
- Clock derivado/estruturado permanece fallback e não libera entrada como clock exato.
- Teste: separação semântica e rollover.

### 4. Expiração
- Parser reconhece formatos como `5 seg`, `60 s` e `1 min`, inclusive ao redor do rótulo Expiração.
- Valor observado é publicado separadamente via `ATS_PLATFORM_CONTROLS_OBSERVED`.
- Expiração diferente de 60 s mostra instrução explícita para alterar para 1 min.
- A análise técnica continua; somente a entrada final é bloqueada até M1 + 60 s.
- Teste: parser/canal separado e bloqueio de entrada.

### 5. Preço, OHLC e velas
- A tela principal mantém preço, abertura, máxima, mínima, atual e últimas 10 velas.
- Enquanto o histórico real chega, o contador mostra `CARREGANDO`, evitando apresentar `0/10` como estado final.
- O health loop tenta reinjetar leitores quando ativo, preço, 10 velas, countdown ou expiração não chegam após o início da sessão.
- Dados do ativo anterior não são reutilizados depois de uma troca confirmada.
- Teste: presença dos campos, histórico de 10 velas e fonte OHLC estruturada.

### 6. Scores/indicadores
- A UI principal usa um único componente `ANÁLISE TÉCNICA`.
- `technicalConfidence` é o score técnico consolidado de 0 a 100.
- O status de tempo da CasaTrade fica dentro do mesmo componente como pré-condição, sem trocar o nome do score.
- Teste: existe exatamente um `triggerCard` primário.

### 7. Funil de sinal
- `processSnapshot()` permanece com um único owner no runtime: `background.js`.
- Fontes de aquisição apenas atualizam estado consolidado.
- Follow-up central dentro da janela final preserva os dois hits necessários para `ENTER`.
- Entrada final continua bloqueada por tempo/expiração quando necessário, sem apagar um pré-sinal técnico válido.
- Gemini só é solicitado após `ENTER_BUY/ENTER_SELL` acionável; nunca em `POSSIBLE`.
- Testes: single-owner burst regression + gating/Gemini.

### 8. Interface tablet/celular
- Primeira tela prioriza: conexão, ativo, timeframe, expiração, countdown, próxima vela, sinal, COMPRA/VENDA, preço, OHLC e 10 velas.
- Gemini, qualidade, ajustes e diagnóstico ficam em `AVANÇADO ▸`, recolhido por padrão.
- `boot-guard.js` captura erro síncrono/assíncrono e força o painel a ficar visível, evitando tela branca silenciosa.
- Teste: ordem dos componentes, `details` avançado e boot guard.

### 9. Critérios de aceite

Automatizados:
1. Troca de ativo: observer + OTC distinto + limpeza de sessão/histórico.
2. Expiração: leitura independente + 60 s obrigatório para entrada.
3. Countdown: rollover e separação da expiração.
4. Funil: rajadas de aquisição não resetam confirmação; único owner do motor.
5. UI: primeira tela compacta e painel avançado recolhido.
6. Boot: falhas de inicialização não deixam tela branca silenciosa.

Validação manual obrigatória na CasaTrade:
1. Trocar entre pelo menos 3 ativos, incluindo OTC e não-OTC; confirmar atualização de ativo/preço/velas sem mistura.
2. Alternar expiração entre 5 s e 1 min; confirmar mensagem de bloqueio e posterior liberação.
3. Manter 3 velas M1 completas; observar countdown `...3,2,1 → 59/60` em todas.
4. Manter 5 minutos; confirmar que o funil pode produzir `POSSÍVEL` e, quando o padrão/thresholds realmente qualificarem, `ENTRAR`. O teste não força sinal artificial quando o mercado não qualifica.
5. Fechar e reabrir o sidepanel; confirmar ausência de tela branca.

> A suíte automatizada não substitui a validação ao vivo da CasaTrade, porque DOM, frames, WebSocket e controles visíveis dependem da sessão real da plataforma.

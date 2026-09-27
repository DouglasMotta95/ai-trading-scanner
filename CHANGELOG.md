# Changelog

## 0.11.85 — sincronização do ENTER + conexão viva

### Diagnóstico confirmado após a observação ao vivo

Foram identificados dois sintomas distintos no v0.11.84:

1. vários `POSSÍVEL` sem chegar a `ENTRAR`;
2. a interface mudava para `DESCONECTADO` mesmo depois de a sessão estar conectada.

### ITEM 1 — POSSÍVEL sem ENTER

Havia uma inconsistência entre o owner técnico e a camada de política:

- `src/core/orchestrator.js` é o owner técnico e pode promover o ciclo para `ENTER_BUY/ENTER_SELL` com os gates técnicos já existentes;
- `src/background-decision-policy.js` reconstruía `professionalDecision` e, até esta versão, só aceitava `ENTER` se também `professional.contextReady === true` e `professional.triggerReady === true`;
- quando o orquestrador técnico já confirmava o ciclo, essa segunda camada podia rebaixá-lo para `POSSIBLE`;
- `src/sidepanel/app-v2.js` prioriza esse `POSSIBLE` na apresentação, ocultando o ENTER técnico.

### Correção

A camada de política agora aceita a confirmação técnica **já emitida pelo orquestrador** quando continuam verdadeiros os mesmos gates técnicos finais:

- `technicalFinal`;
- padrão técnico pronto;
- score >= `finalScore`;
- poder >= `finalPower`;
- confluência >= `minimumConfluence`.

Não houve redução de thresholds nem criação de uma nova condição de entrada. A correção apenas impede que uma segunda camada contradiga a decisão do owner técnico.

O caminho profissional continua válido quando `contextReady + triggerReady` estão completos.

O gate de `entryTimeReady/expirationTimingCompatible` do v0.11.83 permanece intacto.

### ITEM 2 — falso DESCONECTADO

A UI dependia de `lastSeen` para considerar o transporte vivo. Assim, um intervalo temporário sem atualização de cotação podia fazer o indicador cair para `DESCONECTADO`, mesmo com o countdown exato da CasaTrade continuando fresco e vinculado ao mesmo ativo/frame.

### Correção

`liveTransportHandshake()` agora considera a sessão viva quando existe pelo menos uma destas evidências:

1. dados de mercado recentes, como antes; ou
2. clock exato da CasaTrade ainda fresco, autoritativo, pertencente ao mesmo ativo e vinculado ao mesmo frame.

O clock é usado **somente para o status de conexão da UI**. Ele não libera entrada por si só e não altera nenhum gate técnico/temporal.

### O que NÃO foi alterado

- score e fórmula de score;
- perfis RIGIDO/MEDIO/SOLTO;
- thresholds;
- filtros sombra;
- licença;
- Gemini;
- execução;
- `rejectionStrength`;
- continuação/momentum;
- `entryTimeReady`;
- `expirationTimingCompatible`;
- fonte autoritativa do relógio;
- exigências de M1/expiração para entrada.

### Arquivos alterados

1. `src/background-decision-policy.js`
2. `src/sidepanel/ui-shell-v2.js`
3. `manifest.json`
4. `CHANGELOG.md`


## 0.11.84 — auditoria de rejectionStrength e decisão final (sem mudança de estratégia)

### Objetivo da investigação
A evidência ao vivo em EUR/USD M1 sugeriu que `decisionQuality` poderia estar exigindo simultaneamente rejeição forte, continuação forte, momentum forte e força da vela forte. O objetivo desta versão foi verificar essa hipótese diretamente no código do HEAD v0.11.83 e não alterar a estratégia sem evidência estrutural.

### (a) O que `rejectionStrength` realmente mede
No arquivo `src/core/analysis.js`, a função `shape()` calcula:
- `range = high - low`;
- `bodyRatio = |close - open| / range`;
- `upperRatio = (high - max(open, close)) / range`;
- `lowerRatio = (min(open, close) - low) / range`.

Em `analystMetrics()`:
- `rejectionBuy = lowerRatio * 100`;
- `rejectionSell = upperRatio * 100`;
- `rejectionStrength` usa a rejeição direcional quando existe; sem direção de rejeição, usa o maior dos dois pavios.

A rejeição direcional só é criada quando o pavio correspondente supera o limiar do perfil **e** a vela atual fecha na direção correspondente:
- BUY: pavio inferior + `close > open`;
- SELL: pavio superior + `close < open`.

Portanto, `rejectionStrength` mede a **geometria da vela atual**. Não existe, nessa fórmula, uma comparação direta com uma tendência anterior, uma média de velas anteriores ou um “grau de reversão da tendência recente”. A informação histórica entra separadamente em momentum/continuação/agreement.

### (b) Relação matemática com força, continuação e momentum
Para uma vela válida, a geometria satisfaz:

`bodyRatio + upperRatio + lowerRatio = 1`

Como `currentStrength = bodyRatio * 100`, uma rejeição direcional forte e uma força de vela muito alta ocupam a mesma faixa da vela e ficam geometricamente limitadas.

No perfil MEDIO:
- rejeição >= 45% + força >= 55% consome 100% da faixa;
- para manter ambos simultaneamente, o pavio oposto teria de ser 0%.

No RIGIDO:
- rejeição >= 50% + força >= 62% soma 112%;
- portanto essa combinação é matematicamente impossível.

No SOLTO:
- rejeição >= 40% + força >= 50% soma 90%;
- sobra no máximo 10% para o pavio oposto.

Isso explica diretamente o padrão observado no diagnóstico: quando `rejectionStrength` chega a 74–78%, a força do corpo precisa ser baixa; quando a força do corpo está em 71–74% ou próxima disso, a rejeição de um único pavio tende a ficar pequena.

A continuação também não é um indicador de reversão. No código, `continuationScore` é:

`agreement * 45 + momentumScore * 0.30 + currentStrength * 0.25`

quando direção da vela atual e direção do momentum coincidem; caso contrário, é 0. Assim, continuação recebe contribuição **positiva** de momentum e força da vela.

O `momentumScore` é calculado sobre a sequência recente de fechamentos: combina consistência direcional (`abs(net) / activity`, peso 65%) e deslocamento do preço em relação à faixa média (`displacement`, peso 35%). Portanto, momentum representa movimento direcional recente; também não é uma medida de “reversão confirmada”.

### (c) A regra de quatro AND existe no HEAD v0.11.83?
**Não.**

Em `src/core/orchestrator.js`, `highConfidenceEvidence()` adiciona separadamente:
- rejeição;
- continuação;
- momentum;
- força da vela.

Na função `decisionQuality()`, o modo **SIMPLES** usa:
- score final >= `signalPolicy.finalScore`;
- poder direcional >= `signalPolicy.finalPower`;
- número de evidências fortes >= `signalPolicy.minimumConfluence`.

No perfil MEDIO, isso corresponde a:
- score final >= 66;
- poder direcional >= 59;
- mínimo de 2 evidências fortes.

Ou seja, a semântica é de **confluência mínima**, não “rejeição E continuação E momentum E força”.

O próprio caminho **EXIGENTE** também não usa os quatro ao mesmo tempo. Ele possui caminhos alternativos de setup: rejeição, continuação, momentum ou confluência forte, cada um com seus próprios requisitos.

Além disso, `src/core/orchestrator-legacy.js` usa uma condição explícita de alternativas para qualidade final:

`candleStrong || rejected || broke || continuation || trendAligned`

### Conclusão de engenharia
A hipótese “há um defeito porque quatro sinais opostos estão sendo exigidos simultaneamente” **não descreve o código atual**. A geometria de `rejectionStrength` explica por que rejeição e corpo muito forte raramente aparecem juntos, mas isso não bloqueia a decisão atual quando continuação + momentum + força já fornecem a confluência mínima exigida.

Por isso, **não foi alterado nenhum limiar, fórmula, operador AND/OR, perfil, filtro sombra, licença, Gemini, execução ou gate temporal do v0.11.83**.

### Implicação para o diagnóstico ao vivo
Se o diagnóstico ao vivo mostrar score 71–74, continuação >= 55, momentum >= 40 e força >= 55 e ainda assim `decisionQuality.qualifies=false` no modo SIMPLES, o próximo bloqueador a verificar é o restante de `commonReady`, principalmente:
- poder direcional abaixo de 59;
- menos de 2 evidências reconhecidas pelo próprio `highConfidenceEvidence()`;
- direção/score reais diferentes dos valores exibidos;
- build executada diferente do HEAD auditado.

Isso é diferente de “rejectionStrength precisa estar >=45 junto com os outros três”.

### Compatibilidade com v0.11.83
O fix de `entryTimeReady/expirationTimingCompatible` e todos os gates temporais do v0.11.83 foram preservados integralmente. Esta versão é somente uma auditoria/documentação + alinhamento de versão.

### Arquivos alterados
- `manifest.json` — versão 0.11.84 e `version_name` descritivo.
- `package.json` — versão alinhada para 0.11.84.
- `CHANGELOG.md` — registro completo da investigação.

**Arquivos de estratégia alterados: nenhum.**
**Mudança de regra de entrada: nenhuma.**


## 0.11.76 — diagnóstico completo do focused asset + relógio M5

### ITEM 1 — Diagnóstico incompleto
**Causa raiz:** background-control.js já solicitava os quatro retratos, mas focused-asset-v2.js não tinha listener para ATS_EXPIRATION_DIAGNOSTIC_REQUEST. Assim, três leitores respondiam e o quarto permanecia ausente até o timeout de 260 ms.

**Correção:**
- focused-asset-v2.js agora responde com ATS_FOCUSED_ASSET_DIAGNOSTIC_SNAPSHOT, preservando o mesmo requestId.
- O payload inclui o último winner.asset bruto, winner.blocked/blockedReason, contagem de candidatos de texto, indicação entre text-found, text-found-but-rejected e no-corresponding-text-found, além do motivo da rejeição quando aplicável.
- background-control.js só encerra a coleta antecipadamente depois das quatro respostas: canvas + embedded feed + network + focused asset.

**Arquivos alterados:** src/content/focused-asset-v2.js, src/background-control.js

### ITEM 2 — CRÍTICO — relógio M5
**Causa raiz:** structuredCandleBoundary() em embedded-feed-bridge.js exigia que o timestamp bruto da última vela fosse divisível diretamente por toda a duração do timeframe. Isso é correto para M1, mas rejeita uma vela M1 legítima dentro de uma janela M5: por exemplo, uma vela abrindo em 12:03 não é divisível por 300 s, embora pertença à janela M5 iniciada em 12:00.

**Correção:**
- Quando o timeframe alvo é M5 e o feed subjacente é identificado como M1 pelo timeframe da vela ou pela cadência real de aproximadamente 1 minuto entre as duas últimas velas, o código calcula o bucket M5 que contém o timestamp real recebido.
- Só aceita o alinhamento quando esse bucket é exatamente a janela M5 atualmente aberta; não desloca uma vela histórica para uma janela futura.
- O fechamento continua sendo início da janela M5 + 300 s, usando os mesmos timestamps/velas já disponíveis.
- O caminho M1 mantém a regra anterior de grade de 60 s, sem passar pelo novo alinhamento.

**Verificação dos dois timeframes:** validação estática do fluxo e teste sintético separado confirmaram que M1 continua na regra de 60 s e que uma sequência de timestamps M1 dentro da janela corrente passa a produzir network-server-cycle válido para M5. Não foi possível executar uma sessão CasaTrade ao vivo neste ambiente, portanto a validação final em navegador continua sendo necessária.

**Arquivo alterado:** src/content/embedded-feed-bridge.js

### ITEM 3 — investigação de rejectionStrength
**O que a lógica realmente mede:** para BUY, rejectionStrength é o percentual da faixa da vela ocupado pelo pavio inferior; para SELL, é o percentual ocupado pelo pavio superior. A direção de rejeição só é atribuída quando esse pavio atinge o limiar do perfil e a vela fecha na direção correspondente.

**Compatibilidade lógica:** rejeição não é obrigatoriamente incompatível com continuação/momentum — uma vela pode rejeitar preços inferiores e ainda fechar forte para cima. Porém, quando também se exige força da vela alta, há uma restrição geométrica importante porque corpo + pavio superior + pavio inferior = 100% da faixa. No perfil MEDIO, por exemplo, rejeição >=45% junto de força >=55% deixa no máximo 0% para o pavio oposto; no RIGIDO (50% + 62%) essa combinação é matematicamente impossível; no SOLTO (40% + 50%) sobra no máximo 10%. Portanto, exigir os quatro requisitos simultaneamente seria estruturalmente raro/restritivo.

**O ponto decisivo no HEAD v0.11.75:** o orquestrador atual não exige rejeição E continuação E momentum E força. Em highConfidenceEvidence(), essas evidências são adicionadas separadamente; decisionQuality() usa commonReady com score, poder direcional e um número mínimo de evidências. O caminho legado também usa candleStrong OR rejected OR broke OR continuation OR trendAligned. Assim, rejectionStrength=0 por si só não explica decisionQuality=false no código atual quando continuação/momentum/força já estão válidos. O bloqueio precisa estar em outro requisito de commonReady (por exemplo, poder/confluência/contexto) ou indicar diferença entre o código executado ao vivo e este HEAD.

**Recomendação:** não alterar limiar, fórmula nem transformar a regra nesta versão. A semântica OR já está implementada nas camadas relevantes; trocar de AND para OR seria redundante e poderia mascarar o bloqueio real. O item fica documentado para próxima coleta diagnóstica com os campos de candidateBlockerTrace.

**Arquivos alterados:** nenhum em src/core para este item.

### Estabilização geral após o checkup
- **Clock M5:** corrigido também o caminho `market-cycle-clock-v4.js` que usa candles estruturados para derivar o fechamento. Quando a fonte real expõe uma cadência M1, o timestamp é alinhado ao bucket M5 que contém a vela atual; timestamps fora da janela corrente continuam bloqueados.
- **Teste de contrato:** o contrato da build foi atualizado de 0.11.63 para 0.11.76 e ganhou regressão estrutural específica para o alinhamento M1 → M5.
- **Saúde do scanner:** o painel passa a exibir ATIVO, FEED, CLOCK e EXP em quatro estados compactos, além de priorizar o bloqueio operacional concreto atual (ativo, feed, clock, expiração ou motor técnico).
- **Backend:** package `backend` e constantes de versão/default da API foram alinhados para 0.11.76 para evitar divergência dentro do repositório.
- **Sem mudança de estratégia:** não foram alterados thresholds, fórmula de score, perfis, filtros sombra, Gemini ou execução manual.

### Versão e escopo
- manifest.json: 0.11.76
- package.json: 0.11.76
- backend/package.json: 0.11.76
- Sem alterações em licença, Gemini, execução manual, perfis/filtros sombra ou arquitetura de sessão de mercado.


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

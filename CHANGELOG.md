# Changelog

## 0.12.6 — Restore technical decisions and refresh analysis on asset switch

### Findings from video 20859
- The panel badge visibly showed **v0.12.4**, not the v0.12.5 package supplied earlier. This recording therefore ran the older UI and cannot verify the score-visibility fix.
- In the primary `decisionModel`, the mode-conflict and `!timingReady` branches returned early with score 0 before reading the primary technical signal. That masked an available technical score whenever the operation clock/expiration was blocked.
- Active-asset identity gates could continue to see the previous signal/current candle after switching symbols, leaving the panel stuck at “analyzing” and avoiding a new analysis cycle.

### Fixes
- The primary panel now computes technical score/direction before applying timing authorization. Mode/clock mismatch is attached as a blocker message, and the entry remains non-actionable until all operational gates pass.
- Score selection no longer lets an operational zero mask a positive score from the technical engine.
- Added a safe active-asset transition: discard the prior asset's signal/professional decision/cycle immediately when the selected focus changes, retain the old candle's asset label as a safety marker, and wait for fresh candles tagged to the new symbol or history keyed to that asset.
- Analysis resumes from the current asset's keyed history, replacing stale `currentCandle` and resetting the orchestrator when needed. Unkeyed candles from the prior asset are not relabelled as the new asset.
- Added unit tests for asset ownership/reset and contract tests for score visibility under timing blocks.

### Safety
- A technical candidate can be visible while blocked, but no buy/sell entry is authorized until current asset identity, exact clock, timeframe/expiration, and technical final-decision gates pass.
- No automatic trade execution was added.

---

## 0.12.5 — Keep technical score visible when entry timing is blocked

### Regression observed in video 20843
- The panel remained connected and showed an M1 countdown, but the technical card displayed `AGUARDANDO TEMPO CASATRADE` and `0/100`.
- The card used `analysisReady = marketReady && timingReady`; this coupled technical-score display to strict timing/expiration verification and forcibly set the score to zero when only the entry timing gate was blocked.
- Score precedence started with `professionalDecision.score`, so a zero from a blocked decision could mask a nonzero technical-engine score.

### Fix
- Separate market/candle readiness (allowed to calculate and display analysis) from time/expiration authorization (required to promote an entry).
- Calculate and show the best available technical score from the technical engine/entry-confidence outputs even if the operational decision has a zero score due to a timing block.
- Keep buy/sell entry authorization gated by the exact CasaTrade clock, matching timeframe, real expiration verification, technical final decision and actionable flag.
- Keep directional patterns visible with an explicit `Entrada bloqueada: ...` reason when timing or expiration is not validated instead of replacing analysis with an empty `AGUARDAR TEMPO` card.
- Added tests proving score visibility and that timing/expiration failures still prevent final-entry display.

### Safety
This changes display/diagnostics only. It does not permit an entry when the clock or expiration is unverified and does not auto-execute orders.

---

## 0.12.4 — Decision audit: score, pattern, blocker, timing and delivery

### Purpose
- Make every score-80-without-entry case diagnosable from the actual live decision flow, not from a screenshot alone.
- Persist a bounded 40-event audit history on scanner state; refresh the current countdown without adding a new historical event for every sub-second poll.

### Five-part audit now visible in the panel
1. **Score and direction:** overall score, technical direction even when the policy is still waiting, directional power and confluence.
2. **Pattern and trigger:** identified/qualified pullback, pattern score, stretch/room measures, context and trigger readiness, rejection/continuation/momentum evidence.
3. **Exact blocker:** active gate reason (market identity, exact clock, expiration/mode, context, trigger, confirmation/hold or final decision).
4. **Candle deadline:** asset/timeframe/expiration, seconds remaining, target candle time and clock/expiration readiness.
5. **Signal delivery:** notification eligibility reason, stage, whether attempted, and separate native-notification/sound results (delivered, failed, disabled, deduplicated or not eligible).

### Wiring
- Background decision-policy records live per-cycle audit changes using `buildDecisionAudit` and `appendDecisionAudit`.
- The notification worker explains why each signal is eligible or not; it records actual delivery outcomes and updates the matching historical cycle event.
- The panel displays the five fields and a short recent history. The copyable technical diagnostic now includes the same audit trace for support/replay.
- Added pure unit tests for audit creation, bounded history, delivery updates and alert eligibility explanations; added integration contract tests for the live pipeline.

### Safety
- This update does not loosen entry criteria or auto-execute trades. It improves observability to separate technical non-qualification, safety blockers and notification failures.
- One package should be installed only after full validation and direct ZIP packaging succeed.

---

## 0.12.3 — Frame-aware CasaTrade mode synchronization

### Fix from video 20837
- v0.12.2 changed the scanner to M5 but failed to adjust the CasaTrade chart. The existing sync attempted to change timeframe and expiration together in one frame and only reported success if both controls could be read back there.
- Apply the timeframe and expiration independently across candidate CasaTrade frames. A field is accepted only after its own control is reread and matches the requested value.
- Diagnostics now show per-field match/application/frame and report partial synchronization precisely; entries remain blocked unless both controls are confirmed.
- Added regression contract coverage and bumped the package to v0.12.3.

---

## 0.12.2 — Automatic expiration/timeframe mode synchronization

### Problem observed in screenshot 20832
- The CasaTrade expiration was set to 5 minutes, but the scanner remained in M1 and continued showing a 16-second M1 countdown.
- The panel's manual expiration field only stored `userDeclaredExpiration`; it did not change `analystPreferences.operationMode` or apply the corresponding timeframe to the selected CasaTrade chart. This left M1 clock + 5-minute expiration mismatched, so analysis and signals were blocked.

### Corrections
- Selecting a canonical 5-minute expiration now changes the scanner operation mode to M5; selecting 1 minute changes it to M1.
- A fresh, high-confidence `casatrade-expiration-probe-v3` observation also updates the canonical operation mode when the user changes expiration directly on CasaTrade.
- On mode change, the extension attempts to set both the chart timeframe and expiration through the existing platform-sync control writer, then rereads both controls and records whether they matched.
- Persists the auto-selected mode in the sidepanel preference store so a panel reload does not silently revert to M1.
- Clears the previous signal/decision cycle during a mode transition to prevent M1 signals from leaking into M5.
- The panel now distinguishes controls-applied from real runtime confirmation. If the control write cannot be verified, it explains the mismatch and continues blocking entries until the exact CasaTrade clock and expiration agree.

### Safety and tests
- Automatic synchronization changes only timeframe/expiration controls; it does not click BUY/SELL or execute trades.
- Short expirations (5/15/30 seconds) do not silently map to M1/M5.
- Added unit and integration-contract tests for canonical mapping, trusted-source/freshness requirements, automatic control application and readback.
- No release until extension syntax, all tests and direct-install package workflow pass.

---

## 0.12.1 — Proactive pattern alerts and bounded pullback entries

### Goal from user feedback
- Identify promising next-candle setups before the last seconds of the candle, rather than only waiting for a generic high score or final window.
- Explicitly call out a qualified pullback/continuation pattern and the direction (BUY/SELL) while keeping the final signal separate.

### Changes
- A validated pullback/continuation pattern can publish an early candidate with a lower global-score floor (45/100) and directional-power floor (52%), only when pattern score >=80/100, the trigger is not stretched, and room to the opposing level is >=0.35 average candle ranges.
- M1 candidate window: up to 45s remaining. M5 candidate window: up to 120s remaining. M5 final-confirmation window expanded to 30s, leaving time for two bounded observations.
- UI reason now states "Padrão de pullback + retomada", pattern-quality score, average-range room, direction and remaining time. Notifications use an explicit "Padrão para a próxima vela" label.
- A pullback-specific final-entry path uses a score floor of 64/100 and directional power of 55%, plus an independent same-direction rejection/continuation/momentum/strong-candle confirmation. The normal exact-clock, asset-focus, expiration-match, and confirmation-hit/cycle guards remain active.
- Regression tests verify early BUY/SELL candidates, room/stretched gating, M1/M5 alert lead windows, notification wording, and that no pattern means no early M5 notification.

### Retained safeguards
- A preview is not automatic execution; it is an anticipatory signal for the user.
- No final alert is emitted for AGUARDAR.
- No active market is guessed, and no trade is fired from a provisional candidate.

---

## 0.12.0 — Pattern-aware pullback continuation

### Analysis from video 20791
- The chart shows a short-term bullish recovery with several advancing candles, but the scanner remained around 47–48/100 and did not label a setup. The visible chart was near an upper price/resistance area, so the correct behavior is to identify the potential structure while not promoting a late buy into nearby resistance.
- The prior analyzer primarily scored candle majority, strong body, breakout, and rejection. It did not explicitly score a pullback followed by resumption with higher low/high, non-extended trigger candle and measurable room to the opposing swing level.

### Changes
- Add a symmetric bullish/bearish pullback-continuation detector using the real OHLC candles.
- Add explicit quality checks for higher low/high, resumption in the intended direction, candle range/body versus recent average range, cumulative displacement, and room to the nearest opposing swing.
- Expose the pattern and its blocker reason in analysis output. If it is too stretched or too close to resistance/support, remain WAIT and explain why rather than forcing an entry.
- Let a qualified pattern contribute to professional context, trigger, confluence and signal confirmation in the existing analysis pipeline.
- It remains supporting evidence, not a standalone trade command: the system still requires the appropriate score/power, repeated confirmation, active chart identity, exact clock, matching expiration and final entry gates.
- Add regression tests for bullish and bearish patterns, insufficient room, stretched candles, and integration into professional context.

### Previous consolidated fixes retained
- Unified XOF/XAF recognition across visual, alias, protocol, fallback, network/worker/canvas, inspector and market normalizers.
- Fixed false mode-conflict banner CSS and mode-evidence frame provenance.
- M1+60s and M5+300s notification qualification, with retry if both sound and notification channels fail.
- Direct installable package workflow with manifest at archive root.

### Release condition
- Share the single consolidated extension only after the full test suite and packaging workflow pass. Test success does not substitute for live CasaTrade chart validation, and this update does not guarantee trading outcomes.

---

## 0.11.99 — Full reader consistency and signal alert retry

### Full audit found remaining asset-reader gaps
- v0.11.98 had fixed the main visual, alias and protocol readers but still left the fallback/recovery readers and parsing adapters with short currency allowlists: Quetta fallback bridge, network/worker/canvas probes, standalone instrument probe, opaque-frame recovery, CasaTrade data inspector, background augment, platform registry and core market-session guard.
- All these paths now use the same extended XOF/XAF and common-quote coverage. This matters because a rejected symbol in a fallback path could leave focus, feed, price or candle history unconfirmed even when one parser recognized it.
- Added a source-wide regression test ensuring every listed active/fallback reader keeps XOF and XAF support; added runtime checks for the core guard and platform registry normalizers.

### Signal delivery retry
- The alert pipeline previously reserved a candle stage before trying notification/sound delivery and never released it on total failure. If Chrome rejected the first notification and audio was unavailable, the same candle could not retry.
- The stage is now released when both output channels fail, preserving deduplication on successful delivery and allowing a later state update to retry.

### All prior fixes retained
- Generic false mode-conflict banner respects the HTML hidden state.
- Mode comparison preserves per-field source/frame provenance.
- Pre-signal display stability stays presentation-only.
- M1+60s and M5+300s notification qualification remains gated by online state, exact clock, confirmed expiration, matching direction and the final decision state. No automatic trading is enabled.

### Release condition
- Share one consolidated package only after the full CI suite and packaging pass. Runtime validation still must confirm the extension connects to the selected CasaTrade chart and sends signals in the actual browser.

---

## 0.11.98 — Consolidated M1/M5 signal notifications

### Signal delivery correction
- Found a hard-coded notification restriction to M1/60s. M5 could be analyzed and shown in the panel but would not trigger the browser notification path.
- Added a pure, unit-tested qualification helper for both valid operating pairs: M1 + 60s and M5 + 300s.
- Pre-signal notifications require a matching POSSIBLE_BUY/POSSIBLE_SELL and direction. Final notifications require matching ENTER_BUY/ENTER_SELL; AGUARDAR can no longer create a misleading final notification.
- Notifications still require connected/scanning state, confirmed clock and expiration gates, a cycle key, and the intended final timing window.

### Previous corrections included
- Fix false generic mode-conflict banner CSS.
- Recognize XOF/XAF in focused visual, alias, protocol and market-session parsing paths.
- Preserve focus-frame provenance, signal display stability and exact clock/expiration safeguards.

### Release condition
- Release a single consolidated package only after all tests and packaging succeed. Browser-level live CasaTrade signal delivery still needs real-environment verification.

---

## 0.11.97 — Final consolidated recovery for videos 20728/20730/20734/20737

### Additional gap found before release
- The protocol focus reader (`focused-asset-protocol.js`) still maintained its own older currency allowlist and compact-pair expression, so it could reject `USD/XOF (OTC)` even after the two visual readers were corrected.
- The background market-session normalizer had another shorter quote list for compact symbols.

### Final consolidated changes
- Correct all selected-asset readers/normalizers for `XOF`, `XAF` and common OTC quote currencies (visual focus, alias bridge, protocol focus, market-session compact normalization).
- Include the previous false mode-banner CSS fix, mode-evidence frame binding and pre-signal display stability in the same package.
- Add executable regression tests for the three independent content-side parsers and compact state normalizers so the same rejection is caught before packaging.

### Release condition
- Ship one package only after the full CI validation and packaging workflow succeeds.
- Keep exact-clock, focus, expiration and technical-entry gates unchanged; never guess the active instrument when focus is ambiguous.

---

## 0.11.96 — Consolidated fix for videos 20728/20730/20734/20737

### Corrections included in this one build
- Preserve v0.11.92/0.11.93 pre-signal display stability and focused-frame provenance for CasaTrade mode evidence.
- Preserve the v0.11.94 CSS rule that actually hides the generic mode-conflict banner when it is not active.
- Preserve v0.11.95's broader quote whitelist in the chart-scoped focused-asset reader.
- **Also fix the second independent reader** (`focused-asset-alias-bridge.js`), whose shorter quote whitelist still rejected `USD/XOF (OTC)` and `USD/XAF (OTC)`. That gap could keep focus publication from occurring even after the first parser had been patched.
- Add regression coverage for both readers parsing `USD/XOF (OTC)`, `USD/XAF (OTC)` and `EUR/USD (OTC)` while retaining ambiguity safeguards.

### Verification
- This build does not relax the chart-focus, exact-clock, expiration or technical-entry checks.
- Automated validation and packaging are required before sharing the single consolidated package; live CasaTrade validation remains a separate step.

---

## 0.11.95 — Video 20737: recognize USD/XOF OTC focus

### Problema observado
- In the new screenshot the selected CasaTrade instrument is `USD/XOF (OTC)`, while the scanner showed `DESCONECTADO`, no asset, and a connection timeout.
- The focused-asset parser restricted quote currencies to a short allowlist that did not include `XOF`; the selected instrument was therefore rejected. Older visible tabs such as `EUR/USD (OTC)` could be misidentified if stale focus evidence survived.

### Correção
- Added `XOF` and `XAF` plus common exotic OTC quote currencies to the parser's allowlist.
- Added a regression test that executes the actual parser block and confirms `USD/XOF (OTC)` and `USD/XAF (OTC)` are recognized.
- Kept the existing ambiguous-market safety gate; the scanner still cannot authorize a trade based on an uncertain chart or stale market.

---

## 0.11.94 — Video 20732/20734: hide false mode-conflict banner

### Problema observado
- The screenshots showed a generic static `CONFLITO DE MODO` banner even while the main state was `AGUARDAR`; this did not show a concrete M1/M5 or 1m/5m mismatch.

### Causa raiz
- The inline stylesheet forced `.mode-conflict-banner` to `display:grid`, which overrode the browser's default hiding behavior for the HTML `hidden` attribute. The stale generic banner therefore remained visible even when the code set `hidden = true`.

### Correção
- Added an explicit `.mode-conflict-banner[hidden] { display: none; }` rule so the banner only appears when the current alignment check detects a real mismatch.
- Added a regression test for the CSS/HTML contract and aligned package and extension versions to 0.11.94.
- This change only fixes the misleading banner; it does not force a buy/sell signal or bypass the scanner's timing and technical-entry checks.

---

## 0.11.93 — Video 20730 focused-frame mode evidence

### Problema observado
- The panel displayed a generic `CONFLITO DE MODO` while the visible runtime status showed M1, a real countdown, and a matching operational 1-minute expiration. A radar recommendation for M5 is advisory and must not change the selected M1 operation.

### Correção
- Preserve source and frame provenance separately for each observed CasaTrade control (timeframe and expiration).
- Use a visible-control value for conflict detection only when it came from the dedicated probe, is fresh, and is bound to the currently focused chart frame (or the top shell when the trader is embedded).
- Fall back to the focused chart's authoritative runtime clock when per-field control provenance cannot be proven; do not report a mismatch based solely on an unattributed merged/global source.
- Preserve all exact-clock, active-focus, expiration-alignment, technical-confirmation and manual-execution gates.
- Add regressions for cross-frame control mixing and align extension/package version to 0.11.93.

### Validation note
- This patch is designed to remove false mode conflicts; an actual M1/M5 or 1m/5m mismatch from fresh, focused evidence remains a conflict.

## 0.11.92 — Video 20728 signal stability + expiration gate

### Corrections
- Keep a recent high-confidence PRE-SIGNAL visible through one brief weak technical sample, for up to 3.5 seconds, only for the same asset, timeframe, cycle, and direction.
- The stability hold is presentation-only: it does not add final confirmation hits and never upgrades a provisional candidate to ENTER.
- Remove the arbitrary 7-second age limit from the existing observed-expiration value in the manual preparation gate. Clock freshness, clock authority, active asset/focus match, professional decision, and a non-empty expiration remain required.
- Align manifest/package versions and add regression tests for weak-tick flicker, expiry of the display hold, direction changes, and the expiration-age regression.

### Verification
- Regression tests are added in `test/fast-live-decision.test.mjs` and `test/video-20728-stability.test.mjs`.
- This is a code patch, not a guarantee of a profitable signal or automatic execution; CasaTrade timing and data authority gates remain in place.

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

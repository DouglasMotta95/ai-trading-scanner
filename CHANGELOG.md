# Changelog

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

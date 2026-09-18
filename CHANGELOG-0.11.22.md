# AI Trading Scanner 0.11.22 — Final Stabilization

## 1. Detecção do ativo
- O parser de instrumentos agora reconhece pares separados e compactos, incluindo `AUD/CAD`, `AUDCAD`, `ETHUSD` e `USOUSD`.
- OTC continua fazendo parte da identidade do instrumento; mercado normal e OTC não são considerados iguais.
- Troca real de ativo/sessão limpa preço, OHLC, histórico, sinal e intenção operacional do ativo anterior.
- O leitor visual continua priorizando item selecionado/interação real do usuário e bloqueia símbolos passivos de listas abertas.

## 2. Handshake de conexão
- Timeout de handshake definido em 7 segundos.
- O handshake só é considerado completo com ativo, preço, foco confiável, countdown real, expiração observada e histórico mínimo.
- Falha encerra o estado pendente com `Falha ao conectar — tentar novamente.`.
- Badge principal usa somente `CONECTADO` ou `DESCONECTADO`.

## 3. Countdown M1
- Countdown visual é projetado continuamente entre heartbeats reais, sem depender de uma atualização de storage por segundo.
- Mantida a proteção explícita de rollover `1/0 -> 59/60`.
- Expiração e countdown permanecem canais independentes.
- Clock antigo perde validade automaticamente e derruba o estado visual de conexão.

## 4. Expiração
- Parser continua lendo segundos e minutos da interface CasaTrade.
- A entrada final exige expiração observada de `60s`.
- Valor diferente de 60s gera instrução explícita para alterar para 1 minuto.
- A análise técnica pode continuar em segundo plano; autorização de ENTRAR permanece bloqueada.

## 5. Preço, OHLC e velas
- Leitura visual de preço reduzida para ciclo de 400 ms.
- OHLC atual pode ser formado por ticks reais observados da CasaTrade enquanto o OHLC estruturado não chegou.
- Parser de rede foi ampliado para associar corretamente histórico/quotes a símbolos compactos.
- Após 4,5 s com leitura incompleta, a extensão tenta recuperar/reinjetar os leitores antes do timeout final.
- Falta de histórico deixa de aparecer silenciosamente como `0/10`; a UI mostra CARREGANDO ou SEM HISTÓRICO.

## 6. Score técnico
- `GATILHO TÉCNICO`, score duplicado e status de tempo espalhado foram consolidados em um único card `ANÁLISE TÉCNICA`.
- O card mantém rótulo fixo e mostra score 0–100, estado técnico, tempo CasaTrade e setup.
- O score é descrito como força técnica interna, não garantia de resultado.

## 7. Funil e Gemini
- O funil principal só promove POSSÍVEL/ENTRAR quando as condições reais de entrada estão válidas.
- O motor técnico continua analisando mesmo quando a entrada está bloqueada.
- Gemini foi alterada para disparar somente depois de `ENTER_BUY/ENTER_SELL` confirmado e `actionable=true`.
- Gemini continua sem autoridade para criar ou liberar uma entrada.

## 8. Interface tablet/celular
- Informações principais permanecem antes da área avançada.
- Gemini, contexto do ativo, configurações e diagnóstico foram reunidos em um único `AVANÇADO ▸`, fechado por padrão.
- Layout ganhou compactação adicional para telas de pouca altura.
- Adicionado `boot-guard.js`: falha de JavaScript agora exibe erro recuperável em vez de painel branco.

## 9. Testes de aceite
- Testes adicionados para parser de ativo, timeout de conexão, separação countdown/expiração, OHLC real observado, UI unificada, Gemini final-only, três ciclos M1 consecutivos e simulação de cinco minutos com confirmação de entrada.
- Teste anterior de single-owner continua garantindo que apenas `background.js` chama `processSnapshot()`.

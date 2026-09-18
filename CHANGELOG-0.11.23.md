# AI Trading Scanner 0.11.23 — Final Stabilization

## 1. Ativo atual da CasaTrade
- Leitores visual e de rede reconhecem pares com separador e compactos, incluindo AUD/CAD, AUDCAD, ETHUSD e USOUSD.
- OTC faz parte da identidade do instrumento e nunca é tratado como o mesmo mercado regular.
- Troca real de ativo/sessão limpa preço, OHLC, candles, histórico, sinal, decisão e intenção do ativo anterior.
- Símbolos passivos de listas abertas não podem substituir o ativo selecionado.

## 2. Conexão
- Handshake máximo: 7 segundos.
- CONECTADO exige ativo confirmado, preço real, countdown exato, expiração observada e 10 velas reais.
- Se o handshake não fechar, a extensão passa para DESCONECTADO com "Falha ao conectar — tentar novamente".
- Uma nova tentativa limpa qualquer erro de handshake anterior.
- Badge principal possui apenas CONECTADO ou DESCONECTADO.

## 3. Countdown M1
- Countdown é derivado do clock real da CasaTrade e projetado continuamente na UI entre heartbeats.
- Proteção explícita de rollover 1/0 -> 59/60.
- Clock expiração e clock da vela são canais separados.
- Clock desatualizado perde validade automaticamente.

## 4. Expiração
- Leitura de segundos/minutos continua baseada no valor realmente visível da CasaTrade.
- Expiração diferente de 60s bloqueia ENTRAR e mostra instrução para alterar para 1 minuto.
- A análise técnica continua em segundo plano, mas não autoriza entrada sem M1 + 60s.

## 5. Preço, OHLC e histórico
- Cotação visual atualizada a cada 400ms.
- CONECTADO só aparece após 10 velas reais carregadas.
- Antes disso a UI mostra CARREGANDO, nunca um 0/10 silencioso como se estivesse pronta.
- OHLC parcial usa somente preços realmente observados da CasaTrade e é marcado como aproximado.
- A vela parcial é ancorada em um closeAt estável da CasaTrade para não reiniciar máxima/mínima a cada tick.
- Leitores são reinjetados automaticamente após 4,5s se preço/histórico/countdown/expiração não chegarem.

## 6. Score e análise técnica
- Existe um único card principal "ANÁLISE TÉCNICA".
- Score tem nome fixo SCORE e escala 0–100.
- Tempo CasaTrade e setup aparecem dentro do mesmo componente.
- Um único módulo de UI é responsável por escrever o score.

## 7. Funil de sinal
- Runtime possui um único dono do processSnapshot: src/background.js.
- background-augment.js, background-integrity.js e background-market-session.js apenas atualizam estado bruto.
- background-fast-decision.js deixou de ser carregado no runtime para não reescrever state.signal fora do loop central.
- Dentro dos 10s finais, primeiro hit forte permanece visível como POSSÍVEL e o segundo hit dentro da janela confirma ENTRAR.
- Reconnect limpa erros antigos sem resetar indevidamente confirmação válida.
- Decisão bloqueada não vira POSSÍVEL/ENTRAR na UI principal até ativo + clock + M1 + expiração 60s estarem válidos.

## 8. Gemini e interface
- Gemini só dispara depois de ENTER_BUY/ENTER_SELL confirmado com actionable=true.
- Gemini não cria nem desbloqueia sinal.
- Gemini, qualidade, ajustes e diagnóstico ficam em um único AVANÇADO recolhido.
- Informações operacionais principais permanecem antes do Avançado.
- boot-guard.js evita tela branca silenciosa ao reabrir o painel e exibe erro recuperável.

## 9. Aceite automatizado
- Ativo direto/compacto/OTC.
- Handshake e timeout.
- Separação countdown/expiração e rollover.
- OHLC observado e recuperação de leitores.
- 10 velas obrigatórias no estado CONECTADO.
- UI técnica única.
- Gemini final-only.
- Três ciclos M1 distintos sem lock antigo.
- Simulação de 5 minutos que alcança ENTRAR quando existe padrão válido.
- Persistência de uma entrada confirmada através de reinício do service worker usando a janela atual 10s/9s.

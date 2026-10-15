# AI Trading Scanner v0.12.16 — auditoria do vídeo 22033

## Evidência do vídeo
- O header da extensão mostra v0.12.15, portanto a gravação é anterior a esta correção.
- No início, a aba EUR/USD (OTC) diverge do ativo de análise USD/CHF (OTC). O bloqueio de segurança é correto enquanto gráfico e estado ainda divergem.
- Após a troca para USD/CHF e depois ETH/USD (OTC), o painel acompanha o ativo, a conta permanece ativa e a expiração manual de 1 minuto aparece, mas a próxima vela não recebe horário confirmado e o status permanece em SINCRONIZANDO CLOCK DA CASATRADE / COUNTDOWN REAL PENDENTE.
- O radar auxiliar chega a mostrar VENDA 68/100. Esse valor não é a pontuação técnica principal nem autorização de entrada.
- Em outro quadro o motor mostra score 52/100, mas ainda sem relógio verificado. A contagem local/aproximada não deve liberar uma operação.

## Causa encontrada
Os leitores de relógio usavam hostname igual como sinal de que a mensagem vinha do frame de gráfico focado. Em layouts Android/tablet, a janela principal pode enviar a leitura com frameId 0 enquanto o gráfico está num iframe de mesmo hostname com outro frameId. O relógio exato era enviado sem vínculo cross-frame e rejeitado pela verificação do background.

## Correção em v0.12.16
- src/content/market-cycle-clock-v4.js: clockFrameBinding diferencia o shell superior do frame focado e inclui vínculo explícito para o clock de canvas. freshExactClock aceita esse caminho somente com crossFrameControl=true, frameId/frameHost de destino exatamente iguais ao foco atual e origem CasaTrade.
- src/content/embedded-feed-bridge.js: o relógio vindo do feed estruturado também inclui o vínculo explícito ao frame focado.
- O background continua sendo a autoridade final da validação. Nenhum tempo estimado é promovido a relógio real.
- A execução continua manual; sem countdown/boundary verificável, a entrada permanece bloqueada.

## Validação reproduzível
- Suíte Node: 563 testes passaram, 0 falhas.
- node --check: 235 arquivos JavaScript/MJS aprovados.
- Manifesto: 31 caminhos referenciados verificados, nenhum ausente.
- ZIP-fonte extraído em diretório limpo e submetido novamente aos testes; ambos os ZIPs passaram em unzip -t.

## Limite
Não houve sessão interativa da conta/feed real CasaTrade após a correção. Os testes confirmam a regra de vínculo entre frames, mas não provam que a plataforma sempre exponha relógio verificável nem garantem operação vencedora ou renda.

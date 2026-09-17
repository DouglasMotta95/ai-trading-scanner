# Fase D — Viabilidade de confluência multi-timeframe M1 + M5

## Conclusão
É viável com os dados que já chegam hoje, sem API externa e sem segundo motor de decisão.

## Evidência arquitetural
O runtime já recebe preço/candles e possui `CandleBuilder` parametrizado por duração (`TIMEFRAMES`). O orquestrador mantém builders por plataforma + ativo + timeframe e já trabalha com histórico fechado e vela corrente. Portanto, M5 pode ser derivado localmente a partir do mesmo fluxo numérico usado pelo M1, agregando cinco buckets M1 ou alimentando um `CandleBuilder` M5 em paralelo com os mesmos preços/timestamps.

## Desenho recomendado para uma rodada futura
1. Manter M1 como timeframe operacional e único responsável pelo ciclo 30s/10s e pela decisão final.
2. Construir M5 somente como contexto de reforço, a partir do mesmo feed e do mesmo ativo focado.
3. Rodar a mesma família de análise sobre candles M5 fechados, sem criar um segundo decisor independente.
4. Quando M1 e M5 concordarem em BUY/SELL, acrescentar reforço limitado ao score/confirmações; quando discordarem, não inverter a direção M1 automaticamente — apenas retirar o bônus ou aplicar penalidade definida.
5. Resetar os buffers M1 e M5 juntos em troca de ativo para impedir contaminação cruzada.

## Cuidados
- É preciso exigir histórico M5 suficiente antes de considerar a confluência válida; enquanto não houver warm-up, o reforço deve ser neutro.
- O bucket M5 deve usar o mesmo relógio/timestamp autoritativo do feed para não desalinhá-lo do M1.
- A vela M5 corrente não deve ser tratada como fechada.
- A confluência não deve duplicar RSI/MACD nem criar decisão paralela; deve entrar apenas como evidência adicional no motor existente.

## Escopo desta fase
Somente investigação e relatório. Nenhuma alteração de runtime, score, decisão, UI ou captura foi implementada.

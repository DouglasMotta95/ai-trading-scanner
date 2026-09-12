# AI Trading Scanner

Extensão Chrome/Edge Manifest V3 + backend Node para leitura e análise de mercado. A CasaTrade é a primeira integração real; captura, normalização, análise, risco e interface permanecem desacoplados por adapters para suportar outras plataformas.

## Versão atual — 0.10.1

Fluxo principal do produto:

```text
Site público
  → criar conta
  → confirmar e-mail
  → Trial/plano liberado
  → painel do cliente
  → baixar extensão + gerar código de 6 dígitos
  → instalar extensão
  → conectar conta
  → abrir CasaTrade
  → sincronizar valor + vela + expiração
  → analisar as últimas 3–5 velas
  → preparar COMPRA/VENDA quando todos os guards permitirem
```

A confirmação financeira final continua manual: o ATS pode destacar o botão correspondente na plataforma, mas não executa a ordem sozinho nesta versão.

## E-mail de confirmação / Resend

O cadastro por e-mail depende de duas variáveis no serviço do Railway:

```text
RESEND_API_KEY=re_...
EMAIL_FROM=AI Trading Scanner <contato@seudominio.com>
```

Também mantenha:

```text
PUBLIC_BASE_URL=https://ats-control-center-v07-production.up.railway.app
```

O domínio/remetente de `EMAIL_FROM` deve estar autorizado no Resend. A chave real fica apenas nas variáveis do Railway e nunca deve ser commitada no GitHub.

Quando o Resend está indisponível ou não configurado, o portal informa isso claramente em vez de dizer que enviou um e-mail. O usuário pode solicitar novo envio na tela de confirmação.

O backend gera um token de confirmação temporário, monta o link público com `?verify=...`, envia o e-mail e, após a validação do token, marca a conta como verificada e libera o Trial conforme as regras comerciais.

Veja `backend/.env.example` para todas as variáveis esperadas.

## Análise prática de 3–5 velas

A decisão ao vivo não fica mais esperando 21 velas.

- Feed estruturado, recente e estável: mínimo de **3 velas fechadas reais**.
- Feed ainda em validação: mínimo de **5 velas fechadas reais**.
- Histórico maior continua útil como contexto, mas não bloqueia a análise curta.

`src/core/analysis.js` avalia as últimas 3–5 velas com foco em price action:

- maioria direcional;
- higher highs / higher lows e lower highs / lower lows;
- corpo dominante;
- pavio de rejeição;
- rompimento da máxima/mínima recente;
- compressão/lateralização;
- doji extremo;
- projeção simples de continuação, rejeição/reversão ou indefinição;
- suporte e resistência das próprias velas recentes.

EMA 9, EMA 21, RSI, MACD, ATR e Bollinger são calculados quando existe histórico suficiente, mas funcionam como **apoio** e não travam a leitura inicial.

O Side Panel mostra direção recente, projeção, alinhamento, suporte, resistência, nota e parecer em português.

## Nota IA / scoring

O ATS mantém um scoring ponderado explícito:

| Fator | Peso |
|---|---:|
| Price action / estrutura | 25% |
| Confluência de indicadores | 20% |
| Tendência / EMAs | 15% |
| Volatilidade | 10% |
| Correlação | 10% |
| Notícias | 10% |
| Momentum | 10% |

Limiares:

```text
Agressivo  ≥ 65
Balanceado ≥ 75
A+         ≥ 85
```

Na operação curta, a estrutura das 3–5 velas recebe prioridade adicional antes da decisão final. Mercado lateral, doji extremo sem contexto, feed não validado, risco bloqueado ou falta de direção impedem uma confirmação final.

Score não representa promessa ou probabilidade garantida de lucro.

## Gestão de risco automática

Perfis atuais:

| Perfil | Risco por entrada | Meta diária | Stop diário | Pausa após perdas |
|---|---:|---:|---:|---:|
| Conservador | 0,5%–1% | 3% | 2% | 2 |
| Moderado | 1%–2% | 5% | 3% | 3 |
| Agressivo | 2%–3% | 8% | 5% | 4 |

O valor automático sugerido usa o limite inferior da faixa do perfil. Se o usuário informar um valor maior, o motor limita a sugestão ao teto do perfil. A gestão também possui proteção contra exposição excessiva, cooldown, aviso de overtrading e bloqueios por meta/stop/perdas consecutivas.

O resultado diário só pode ser atualizado a partir de resultados conhecidos (`win`, `loss`, `draw`) ou estado de risco informado; o ATS não inventa o resultado de uma operação.

## Linhas no gráfico

`src/content/chart-overlay.js` desenha sobre o gráfico detectado sem capturar cliques:

- zona de suporte das últimas 3–5 velas;
- zona de resistência das últimas 3–5 velas;
- linha de tendência curta quando há dados suficientes;
- EMA 9 e EMA 21 apenas quando existe histórico para calculá-las.

O usuário pode ligar/desligar linhas, EMAs, suporte/resistência e tendência pelo Side Panel. O overlay é visual e não altera ordens financeiras.

## CasaTrade e fonte de verdade

O ATS tenta detectar:

```text
ativo
preço
instrumentType
marketType / OTC
vela / timeframe
expiração
valor configurado
```

DOM, SVG e rede são combinados. Canvas não é tratado como texto; quando o gráfico é canvas, contexto e cotação vêm dos controles legíveis e, preferencialmente, do feed de rede entregue à própria página.

A configuração operacional segue:

```text
Usuário escolhe Valor + Vela + Expiração
  → ATS tenta aplicar esses controles não financeiros
  → ATS lê a CasaTrade de volta
  → somente considera sincronizado se os 3 coincidirem
```

Se o ATS não conseguir comprovar uma configuração, ele mostra a falha e não finge que sincronizou.

## WebSocket e privacidade

`src/content/network-probe.js` observa respostas que a própria página recebe e procura extrair cotações estruturadas, OHLC, símbolo, bid/ask, timeframe, expiração, payout e timestamps.

Dados relacionados a autenticação/segredo são descartados. O projeto não coleta cookies, bearer tokens, senhas, chaves de sessão ou headers de autenticação.

Feed provisório pode gerar observação, mas não deve ser promovido a confirmação financeira sem evidência suficiente de cotação estruturada e recente.

## Multiativo

O catálogo combina ativos observados no DOM com símbolos vistos no feed de rede. O background mantém análise por ativo/timeframe e um ranking dos candidatos observados.

Isso não significa que a extensão possa inventar ou consultar mercados que a CasaTrade não entregou à sessão atual: o universo monitorado é o universo efetivamente exposto pela plataforma naquele momento.

## Backtest

O backtest usa a mesma lógica curta de price action, começando a avaliar a partir da quinta vela disponível. Mínimo técnico: 6 candles reais para existir ao menos uma entrada + vela seguinte de avaliação.

Relatórios incluem taxa de acerto, P/L simulado em unidades, drawdown máximo, melhor/pior sequência, perfis Conservador/Moderado/Agressivo e tipo de setup.

## Como testar

1. Configure `RESEND_API_KEY`, `EMAIL_FROM` e `PUBLIC_BASE_URL` no Railway.
2. Crie uma conta com e-mail real e confirme o recebimento do link.
3. Clique no link e valide que o Trial foi liberado.
4. Entre no painel, baixe a extensão e gere o código de conexão.
5. Em `chrome://extensions`, carregue/recarregue a pasta que contém `manifest.json`.
6. Abra a CasaTrade autenticada e recarregue a página para o probe entrar desde `document_start`.
7. Conecte a extensão, escolha valor, vela e expiração e confira `CasaTrade sincronizada`.
8. Aguarde 3 velas com feed estruturado ou 5 enquanto o feed estiver em validação.
9. Confira direção recente, projeção, nota, parecer, suporte e resistência.
10. Ative/desative as linhas para conferir o overlay.
11. Informe uma banca, selecione um perfil e valide entrada sugerida, meta, stop e status.
12. Uma COMPRA/VENDA só deve ser preparada com sinal confirmado, feed validado, configuração alinhada e risco permitido.

## Testes automatizados

```bash
cd backend
npm test
```

O GitHub Actions valida Manifest V3, sintaxe, arquivos obrigatórios, fluxo comercial, análise curta, gestão de risco, overlay, backtest, licenciamento e backend.

## Limitação de calibração

A CasaTrade pode mudar DOM, classes e formato das mensagens WebSocket. A arquitetura falha de forma segura quando não consegue comprovar o dado. A integração precisa ser validada em uma sessão autenticada real; não marque um seletor ou payload como confirmado sem evidência do runtime.

Nenhuma taxa de acerto ou resultado financeiro é garantido. Use Demo/forward-test antes de qualquer uso com capital real.

# AI Trading Scanner v0.12.15 — auditoria da captura 21982

## Evidência
A conta aparece ATIVA, o ativo selecionado é USD/CHF (OTC), o modo visível é M1 e a expiração manual indicada é 1 min. A UI, ao mesmo tempo, mostra “CONECTADO — PRONTO PARA ANALISAR” no cabeçalho e “ATUALIZANDO ATIVO / SINCRONIZANDO CLOCK / COUNTDOWN REAL PENDENTE” no cartão operacional. O score é 29/100 e o poder comprador 41%, abaixo do perfil MÉDIO (52/100 e 45%); essa captura não justificaria uma entrada.

## Alterações
- A UI pode preservar a análise visual por uma janela curta durante pausa de heartbeat, somente se conexão, sessão confirmada, ativo, foco, preço, velas e sinal ainda coincidirem.
- Essa continuidade não autoriza entrada: a decisão continua dependendo de foco fresco, relógio válido, expiração e alinhamento.
- A confirmação de countdown no cabeçalho exige amostra explicitamente disponível, origem permitida, segundos dentro do timeframe e amostra fresca/limite de vela.
- Se foco ou timeframe não forem lidos, o leitor solicita nova leitura em vez de inferir M1/M5 pela expiração manual.
- A versão de extensão, pacotes e API é 0.12.15. O portal identifica a mesma versão.

## Validação
- Suíte local: 558 testes aprovados, 0 falhas.
- 231 arquivos JavaScript/MJS passaram por node --check na cópia de trabalho.
- 31 referências do manifesto conferidas, sem caminhos ausentes.
- ZIP deve ser extraído e testado limpo depois da geração.

## Limite importante
Não foi possível abrir uma sessão interativa com o feed real da CasaTrade nesta validação. Se a plataforma não expuser tempo de vela verificável, o scanner continuará bloqueando a ação em vez de inventar countdown. Não há garantia de operação vencedora ou de renda.

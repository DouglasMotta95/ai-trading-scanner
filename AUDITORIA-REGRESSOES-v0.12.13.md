# Auditoria de regressões — AI Trading Scanner v0.12.13

Data: 13/10/2026.

Foram localizados os vídeos recentes disponíveis (20317, 20730, 20789, 20791, 20837, 20843 e 20859), inspecionados quadros no início/meio/fim e cruzados os sintomas com o histórico de correções e testes. A imagem 21154.jpg foi considerada contexto da conversa interrompida, não evidência técnica suficiente. Os vídeos mostram builds anteriores — 20317: v0.11.104; 20859: v0.12.4 — e não provam o comportamento da v0.12.13 no feed real.

| Material | Sintoma/limite | Cobertura de regressão | Limite |
|---|---|---|---|
| 20317.mp4 | Conflito/espera temporal, expiração declarada confundida com verificação e radar confundido com score principal | Observação por frame, fallback não verificado, testes de modo e relógio | Gravação antiga, não certifica build atual |
| 20730.mp4 | Banner falso de conflito e instabilidade de foco/relógio | Testes de evidência recente do frame focado e regra de visibilidade do banner | AGUARDAR não prova que um candidato qualificava |
| 20789.mp4 | Overlay de corrida cobre parte do painel em quadros centrais | Tratado como limite de visibilidade, sem inferir resultado | Não comprova falha nem correção |
| 20791.mp4 | Pullback/retomada pouco explícito e risco de entrada esticada em resistência | Detector simétrico de continuação, espaço até nível contrário, gatilho e testes | Candidato não equivale a entrada final |
| 20837.mp4 | M5 e expiração não sincronizados/revistos de forma consistente | Sincronização e leitura por campo/frame, bloqueio em divergência | Testes não conectam à sessão ao vivo |
| 20843.mp4 | Score técnico zerado enquanto relógio/expiração bloqueavam entrada | Separação da análise técnica e autorização operacional | Score visível não libera entrada |
| 20859.mp4 | Vídeo mostra v0.12.4 e suspeita de estado/score antigo após troca do ativo | Limpeza do sinal na troca e cache de candles ligado ao ativo; testes de score | Build antiga, não valida a atual |
| 21154.jpg | Captura do chat anterior interrompido; painel de fundo não legível o bastante | Apenas contexto do trabalho | Não comprova estado interno |

## Ajustes desta revisão
- Versão 0.12.13 alinhada entre manifest, package root e API.
- API e download derivam a versão do manifest real, ignorando uma variável de ambiente antiga.
- O portal preserva o painel de diagnóstico e recebe menu mobile acessível, foco visível e suporte a movimento reduzido.
- O conteúdo comercial explica melhor origem dos dados, score, histórico e perfis sem vender a demonstração como sinal ao vivo.
- Adicionados teste de regressão de versão/site/download e instruções de instalação.

## Validação
Na cópia local empacotada: 546/546 testes, node --check em 232 arquivos JS/MJS, 31 referências do manifest verificadas, ZIP instalável e ZIP-fonte aprovados em unzip -t. A API local foi testada com EXTENSION_LATEST_VERSION=0.11.47 deliberadamente antigo e ainda serviu config/download 0.12.13.

## Limite
Não houve sessão interativa com a conta/feed real CasaTrade. Os testes não certificam comportamento ao vivo nem rentabilidade. A extensão mantém entrada manual e não promete lucro.

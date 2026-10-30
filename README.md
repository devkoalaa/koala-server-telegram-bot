# koala-server-telegram-bot

Bot do Telegram para acompanhar e operar o koala-server. Só responde ao chat
definido em `ALLOWED_CHAT_ID`; mensagens de qualquer outra pessoa são ignoradas.

| Comando | O que faz |
|---|---|
| `/status` | CPU, RAM, disco, uptime, estado de cada container e de cada site |
| `/backup` | Último backup de cada banco (data, idade e tamanho) |
| `/logs [container] [linhas]` | Últimas linhas de log (padrão 30, máx. 200); sem argumento, mostra a lista |
| `/restart [container]` | Reinicia um container após confirmação; sem argumento, mostra a lista |
| `/resumo` | Resumo do servidor sob demanda |
| `/semana` | Resumo da semana de treinos no Koala Fit sob demanda |
| `/dieta` | O que foi registrado hoje no diário alimentar e quanto falta para as metas |
| `/produtos` | Produtos com rótulo cadastrado; um botão por produto para marcar que acabou |
| `/claude <pergunta>` | Pergunta ao Claude Code do servidor sobre o código dos projetos — **só leitura** |

### Sobre o /claude

O bot entra por SSH no host com uma chave que o `authorized_keys` prende a
`~/bin/claude-telegram`: esse script só roda `claude -p` com as ferramentas
`Read`, `Grep` e `Glob`, em `~/workspace` mais os checkouts de produção do
koala-fit e deste bot. Nada de editar arquivos ou rodar comandos. Uma pergunta
por vez, com limite de 10 minutos.

### Relatório da balança

Encaminhe o print do relatório de bioimpedância da balança (app OKOK, em chinês)
— de preferência **como arquivo**, porque o Telegram reduz fotos. O bot salva a
imagem em `~/apps/koala-server-telegram-bot/scale-reports` (apagada após 30
dias), o Claude extrai os valores e o bot mostra tudo com os botões ✅ Salvar /
❌ Descartar. Só ao salvar os dados vão para o Koala Fit
(`body_composition_logs` e o peso do dia em `body_weight_logs`).

Isolamento: o bot entra por SSH com uma segunda chave, presa a
`~/bin/claude-scale`. Esse script tem o prompt e o JSON Schema fixos, recebe só
o nome do arquivo e roda `claude -p` com apenas a ferramenta `Read`, liberada
só para aquela imagem. Quem grava no banco é o bot, com o usuário
`koala_fit_scale` (INSERT/UPDATE apenas nessas duas tabelas, além do diário
alimentar abaixo), depois de validar
faixas plausíveis de cada número e da sua confirmação.

### Diário alimentar

Mande o que comeu ou bebeu: texto (“almocei arroz, feijão e um bife”), foto do
prato ou foto com descrição. A descrição tem prioridade sobre o que aparece na
foto. A API do Claude (`ANTHROPIC_API_KEY`, modelo em `FOOD_MODEL`, padrão
`claude-opus-5-5`) separa os itens, estima as porções e devolve calorias,
macros, fibra e água em JSON estruturado. O bot confere faixas plausíveis e
grava direto em `food_logs` do Koala Fit, ligando os itens ao id da mensagem.
A resposta traz o total do dia contra as metas (definidas na aba Dieta do app)
e um botão ↩️ Desfazer, que apaga os itens daquela mensagem. Perguntas em texto
(“quanto falta de proteína?”) são respondidas com base no dia.

Como a foto não confunde com a balança:

- **imagem mandada como arquivo, sem legenda** → vai direto para a balança, como antes;
- **foto, ou imagem com legenda** → vai para o diário. Se o Claude reconhecer um
  relatório de balança, ela segue para o fluxo da balança acima;
- **sem `ANTHROPIC_API_KEY`** → toda imagem vai para a balança, e texto solto
  só recebe o aviso de que falta configurar.

**Produtos com rótulo.** A foto da tabela nutricional de um produto (sem dizer
que comeu) cadastra o produto em `food_products`, com nome, categoria
("iogurte", "pão de forma"...), porção e valores por 100 g. A lista ativa vai no
contexto de toda análise, e o Claude usa esses números quando o produto é citado,
mesmo de forma genérica ("um copo de iogurte"). Cadastrar outro produto da mesma
categoria arquiva o anterior (troca de marca), a menos que a legenda diga que os
dois continuam em uso. O Desfazer do cadastro devolve o anterior. `/produtos`
lista o que está ativo, com um botão para marcar o que acabou. Mande o rótulo
como foto, ou como arquivo com legenda: arquivo sem legenda vai para a balança.

O mesmo usuário `koala_fit_scale` grava o diário (SELECT/INSERT/DELETE em
`food_logs` e SELECT/INSERT/UPDATE em `food_products`, concedidos pelas
migrations do koala-fit).

## Mensagens automáticas

| Quando | O quê |
|---|---|
| Todo dia, 08:00 | Resumo do servidor: recursos, backup da noite e containers que reiniciaram |
| Todo dia, 18:00 | Lembrete de treino, só se o dia está no cronograma do Koala Fit e nada foi registrado |
| Domingo, 20:00 | Resumo da semana de treinos |
| A cada deploy | Resultado da esteira (koala-fit e este bot) |
| Se o backup falhar | Aviso com o log do erro (systemd `OnFailure=`) |
| Site fora do ar | Após 3 verificações seguidas com falha (1 por minuto); avisa de novo quando volta |
| Certificado perto de vencer | Uma vez por dia, se faltarem menos de 14 dias |
| Todo dia, 03:30 | Apaga (sem aviso) prints da balança com mais de 30 dias |

Os horários podem ser trocados no `.env` (ver `.env.example`).

## Verificação dos sites

`src/sites.ts` testa, de fora, os endereços públicos (Koala Fit, Wallet,
portfólio, Favela League, rádio e o relay do Automotiva) como um visitante:
DNS → Caddy → TLS → app. Para incluir um app novo, adicione uma linha em
`SITES`. Intervalo: `SITE_CHECK_INTERVAL_SECONDS` (padrão 60).

## Avisos de outros serviços

O bot expõe `POST /notify` só em `127.0.0.1:8081` no servidor, para que
esteiras e scripts mandem mensagens sem precisar do token:

```bash
curl -fsS 127.0.0.1:8081/notify -H 'content-type: application/json' -d '{"text":"oi"}'
```

O menu de comandos do Telegram é registrado pelo próprio bot ao iniciar, só no
chat autorizado — para os demais, o bot não exibe comandos.

## Deploy

Push na `main` → runner self-hosted no servidor faz `docker compose build` e
`up -d`. O `.env` de produção fica em `~/apps/koala-server-telegram-bot/.env`
no servidor (ver `.env.example`).

## Desenvolvimento

```bash
pnpm install
cp .env.example .env   # use um bot de teste, não o de produção
pnpm dev
```

`/status`, `/logs` e `/restart` precisam de acesso a um Docker local; `/backup`
lê `BACKUPS_DIR` (padrão `/backups`).

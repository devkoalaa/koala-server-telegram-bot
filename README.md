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
`koala_fit_scale` (INSERT/UPDATE apenas nessas duas tabelas), depois de validar
faixas plausíveis de cada número e da sua confirmação.

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

# koala-server-telegram-bot

Bot do Telegram para acompanhar e operar o koala-server. Só responde ao chat
definido em `ALLOWED_CHAT_ID`; mensagens de qualquer outra pessoa são ignoradas.

| Comando | O que faz |
|---|---|
| `/status` | CPU, RAM, disco, uptime e estado de cada container |
| `/backup` | Último backup de cada banco (data, idade e tamanho) |
| `/logs [container] [linhas]` | Últimas linhas de log (padrão 30, máx. 200); sem argumento, mostra a lista |
| `/restart [container]` | Reinicia um container após confirmação; sem argumento, mostra a lista |
| `/resumo` | Resumo do servidor sob demanda |
| `/semana` | Resumo da semana de treinos no Koala Fit sob demanda |

## Mensagens automáticas

| Quando | O quê |
|---|---|
| Todo dia, 08:00 | Resumo do servidor: recursos, backup da noite e containers que reiniciaram |
| Todo dia, 18:00 | Lembrete de treino, só se o dia está no cronograma do Koala Fit e nada foi registrado |
| Domingo, 20:00 | Resumo da semana de treinos |
| A cada deploy | Resultado da esteira (koala-fit e este bot) |
| Se o backup falhar | Aviso com o log do erro (systemd `OnFailure=`) |

Os horários podem ser trocados no `.env` (ver `.env.example`).

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

# koala-server-telegram-bot

Bot do Telegram para acompanhar e operar o koala-server. Só responde ao chat
definido em `ALLOWED_CHAT_ID`; mensagens de qualquer outra pessoa são ignoradas.

| Comando | O que faz |
|---|---|
| `/status` | CPU, RAM, disco, uptime e estado de cada container |
| `/backup` | Último backup de cada banco (data, idade e tamanho) |
| `/logs [container] [linhas]` | Últimas linhas de log (padrão 30, máx. 200); sem argumento, mostra a lista |
| `/restart [container]` | Reinicia um container após confirmação; sem argumento, mostra a lista |

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

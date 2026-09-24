import http from "node:http";

// Internal endpoint so other things on the server (deploy workflows, the
// backup timer) can message the owner without holding the bot token.
// docker-compose only publishes it on the host's 127.0.0.1.
//
//   curl -fsS localhost:8081/notify -H 'content-type: application/json' \
//        -d '{"text":"oi"}'            # "html": true enables HTML formatting

type Send = (text: string, html: boolean) => Promise<void>;

const MAX_BODY_BYTES = 64 * 1024;

export function startNotifyServer(port: number, send: Send) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/notify") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on("end", async () => {
      try {
        const { text, html } = JSON.parse(body) as { text?: string; html?: boolean };
        if (!text) throw new Error("campo 'text' obrigatório");
        await send(text, Boolean(html));
        res.writeHead(204).end();
      } catch (err) {
        res.writeHead(400, { "content-type": "text/plain" }).end(String(err));
      }
    });
  });
  server.listen(port, () => console.log(`Notificações em :${port}/notify`));
}

import { spawn } from "node:child_process";
import { config } from "./config.ts";

// Claude Code runs on the host over SSH. Each key is pinned in the host's
// authorized_keys to one wrapper script, so sshd ignores any remote command and
// the input travels on stdin:
// - /claude → ~/bin/claude-telegram, read-only (Read/Grep/Glob);
// - scale reports → ~/bin/claude-scale (see scale.ts).

let running = false;

export function claudeBusy(): boolean {
  return running;
}

export function askClaude(prompt: string): Promise<string> {
  running = true;
  return runOnHost(config.claudeSshKey, prompt)
    .then((output) => output.trim() || "(resposta vazia)")
    .finally(() => {
      running = false;
    });
}

/**
 * Runs the host command pinned to `key` in authorized_keys, with `stdin` as
 * its input. Resolves with stdout; rejects with the tail of stderr/stdout.
 */
export function runOnHost(key: string, stdin: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const ssh = spawn("ssh", [
      "-T",
      "-o", "LogLevel=ERROR",
      "-i", key,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "UserKnownHostsFile=/tmp/known_hosts",
      "-o", "ConnectTimeout=10",
      `ubuntu@${config.claudeSshHost}`,
    ]);
    let stdout = "";
    let stderr = "";
    ssh.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    ssh.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    ssh.on("error", reject);
    ssh.on("close", (code) => {
      // The wrappers' `timeout` exits with 124.
      if (code === 124) reject(new Error("Tempo esgotado."));
      else if (code === 0) resolve(stdout);
      else {
        const output = `${stderr}\n${stdout}`.trim();
        reject(new Error(output.split("\n").slice(-5).join("\n") || `ssh saiu com código ${code}`));
      }
    });
    ssh.stdin.end(stdin);
  });
}

/** Telegram caps messages at 4096 chars; split on line breaks where possible. */
export function splitMessage(text: string, max = 4000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const at = cut > max / 2 ? cut : max;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

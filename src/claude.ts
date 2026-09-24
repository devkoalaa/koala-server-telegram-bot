import { spawn } from "node:child_process";
import { config } from "./config.ts";

// /claude runs Claude Code on the host over SSH. The key used here is pinned
// in the host's authorized_keys to ~/bin/claude-telegram, a read-only wrapper
// (Read/Grep/Glob only), so the remote command below is ignored by sshd and
// the prompt travels on stdin.

let running = false;

export function claudeBusy(): boolean {
  return running;
}

export function askClaude(prompt: string): Promise<string> {
  running = true;
  return new Promise<string>((resolve, reject) => {
    const ssh = spawn("ssh", [
      "-i", config.claudeSshKey,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "UserKnownHostsFile=/tmp/known_hosts",
      "-o", "ConnectTimeout=10",
      `ubuntu@${config.claudeSshHost}`,
    ]);
    let output = "";
    ssh.stdout.on("data", (chunk: Buffer) => (output += chunk));
    ssh.stderr.on("data", (chunk: Buffer) => (output += chunk));
    ssh.on("error", reject);
    ssh.on("close", (code) => {
      // The wrapper's `timeout 10m` exits with 124.
      if (code === 124) resolve(`${output}\n\n⏱️ Tempo esgotado (10 min).`.trim());
      else if (code === 0) resolve(output.trim() || "(resposta vazia)");
      else reject(new Error(output.trim().split("\n").slice(-5).join("\n") || `ssh saiu com código ${code}`));
    });
    ssh.stdin.end(prompt);
  }).finally(() => {
    running = false;
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

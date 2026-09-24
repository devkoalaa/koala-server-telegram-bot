import http from "node:http";
import { config } from "./config.ts";

// Minimal Docker Engine API client over the unix socket — the bot only needs
// four endpoints, so no SDK dependency.

export type Container = {
  Id: string;
  Names: string[];
  State: string;
  Status: string;
  Image: string;
};

function request(method: string, path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: config.dockerSocket, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function expectOk(method: string, path: string): Promise<Buffer> {
  const { status, body } = await request(method, path);
  if (status >= 400) {
    const message = JSON.parse(body.toString() || "{}").message ?? `HTTP ${status}`;
    throw new Error(message);
  }
  return body;
}

export async function listContainers(): Promise<Container[]> {
  const body = await expectOk("GET", "/containers/json?all=true");
  const containers = JSON.parse(body.toString()) as Container[];
  return containers.sort((a, b) => containerName(a).localeCompare(containerName(b)));
}

export function containerName(container: Container): string {
  return container.Names[0]?.replace(/^\//, "") ?? container.Id.slice(0, 12);
}

// Non-TTY containers return logs multiplexed: each frame is an 8-byte header
// (stream type + big-endian payload length) followed by the payload.
function demux(buffer: Buffer): string {
  let out = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    out += buffer.subarray(offset + 8, offset + 8 + size).toString();
    offset += 8 + size;
  }
  return offset === 0 ? buffer.toString() : out;
}

export async function containerLogs(name: string, tail: number): Promise<string> {
  const body = await expectOk(
    "GET",
    `/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&tail=${tail}`,
  );
  return demux(body);
}

export async function restartContainer(name: string): Promise<void> {
  await expectOk("POST", `/containers/${encodeURIComponent(name)}/restart?t=10`);
}

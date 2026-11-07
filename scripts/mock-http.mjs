import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function mock(t, handler) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const call = { method: request.method, url: request.url, headers: request.headers, raw, body: raw ? JSON.parse(raw) : undefined };
    calls.push(call);
    try {
      const reply = await handler(call, calls);
      response.writeHead(reply?.status ?? 200, { 'Content-Type': 'application/json', ...reply?.headers });
      response.end(JSON.stringify(reply?.body ?? {}));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

export async function tempConfig(t) {
  // Keep test writes inside this task workspace, outside the source checkout.
  const path = await mkdtemp(new URL('../../.mock-config-', import.meta.url).pathname);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export function client(t, { url, config, key = '', handle = '', entry = new URL('../server/index.js', import.meta.url) }) {
  if (!url.startsWith('http://127.0.0.1:')) throw new Error('Tests must use a loopback mock.');
  const child = spawn(process.execPath, [entry.pathname ?? entry], {
    env: { ...process.env, AGENTSWARM_BASE_URL: url, AGENTSWARM_CONFIG_DIR: config, AGENTSWARM_API_KEY: key, AGENTSWARM_HANDLE: handle },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [], pending = new Map();
  let sequence = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    responses.push(message);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message); }
  });
  const exit = new Promise(resolve => child.on('exit', (code, signal) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Server exited: ${code ?? signal}; ${stderr}`)); }
    pending.clear();
    resolve(code);
  }));
  t.after(async () => { child.stdin.end(); child.kill(); await exit; lines.close(); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}; ${stderr}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
  return {
    request, responses, child,
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    async tool(name, args = {}) { return (await request('tools/call', { name, arguments: args })).result; },
    async close() { child.stdin.end(); return exit; },
    stderr: () => stderr,
  };
}
export const data = result => JSON.parse(result.content[0].text.slice(result.content[0].text.indexOf('\n') + 1));
export const credentialsFile = config => join(config, 'credentials.json');

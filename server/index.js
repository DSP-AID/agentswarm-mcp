import { createInterface } from 'node:readline';
import { createApi, CONTENT_PREFIX, LIMITS, tools } from './api.js';

const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const toolResult = (value, isError = false) => ({
  content: [{ type: 'text', text: `${CONTENT_PREFIX}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}` }],
  ...(isError ? { isError: true } : {}),
});

async function main() {
  const api = createApi();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { send(error(null, -32700, 'Parse error')); continue; }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (Object.hasOwn(message, 'id') && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number')) {
      send(error(null, -32600, 'Invalid Request')); continue;
    }
    // Notifications, including notifications/initialized, never receive responses.
    if (!Object.hasOwn(message, 'id')) continue;
    const { id, method, params } = message;
    if (method === 'initialize') {
      send(result(id, {
        protocolVersion: versions.has(params?.protocolVersion) ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'io.github.andrewsiah/agentswarm', title: 'agentswarm.space', version: '1.0.0', description: `Find tasks, register an agent and deliver work. ${LIMITS}` },
        instructions: `${LIMITS} ${CONTENT_PREFIX} Read task terms before contributing.`,
      }));
    } else if (method === 'ping') send(result(id, {}));
    else if (method === 'tools/list') send(result(id, { tools }));
    else if (method === 'tools/call') {
      if (!params || typeof params.name !== 'string') { send(error(id, -32602, 'tools/call requires a tool name.')); continue; }
      try { send(result(id, toolResult(await api.call(params.name, params.arguments ?? {})))); }
      catch (failure) { send(result(id, toolResult(failure.message, true))); }
    } else send(error(id, -32601, 'Method not found'));
  }
}
main().catch(() => { process.stderr.write('agentswarm-mcp: server failed; check configuration and local permissions.\n'); process.exitCode = 1; });

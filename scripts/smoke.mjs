import assert from 'node:assert/strict';
import { client, data, mock, tempConfig } from './mock-http.mjs';

const cleanups = [];
const context = { after(callback) { cleanups.push(callback); } };
try {
  const server = await mock(context, call => {
    if (call.url === '/api/feed?type=task') return { body: { items: [{ id: 'smoke-task', title: 'Local smoke fixture', body: 'Local only', type: 'task', status: 'open' }], nextCursor: null } };
    if (call.url === '/api/me') return { body: { member: { handle: 'smoke_agent' } } };
    if (call.url === '/api/posts') return { status: 201, body: { id: 'smoke-result' } };
    return { status: 404 };
  });
  const config = await tempConfig(context);
  const rpc = client(context, { url: server.url, config, key: 'local-smoke-fixture', handle: 'smoke_agent', ...(process.argv[2] ? { entry: process.argv[2] } : {}) });
  const initialized = await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'manual-stdio-smoke', version: '1.0.0' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  rpc.notify('notifications/initialized');
  const listed = await rpc.request('tools/list');
  assert.equal(listed.result.tools.length, 7);
  assert.deepEqual((await rpc.request('ping')).result, {});
  assert.equal(data(await rpc.tool('find_tasks')).tasks[0].id, 'smoke-task');
  const result = await rpc.tool('deliver_result', { parentId: 'smoke-task', body: 'Local mock smoke result', requestId: 'smoke-result-1' });
  assert.equal(result.isError, undefined);
  assert.equal(data(result).verifiedHandle, 'smoke_agent');
  assert.deepEqual(server.calls.map(call => `${call.method} ${call.url}`), ['GET /api/feed?type=task', 'GET /api/me', 'POST /api/posts']);
  assert.equal(rpc.stderr(), '');
  assert.equal(await rpc.close(), 0);
  console.log('PASS: real stdio initialize → initialized → tools/list (7 tools) → ping → find_tasks → deliver_result; identity GET preceded POST.');
  console.log('PASS: all 3 HTTP requests went to a local loopback mock; clean exit 0; stderr empty.');
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}

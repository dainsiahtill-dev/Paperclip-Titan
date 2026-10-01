import fs from 'node:fs';
import { createInterface } from 'node:readline';
const root = process.argv[2];
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const update = (sessionId, text) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
let active;
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(`${root}/requests.jsonl`, `${JSON.stringify(request)}\n`);
  const reply = (result) => request.id === undefined ? undefined : send({ jsonrpc: '2.0', id: request.id, result });
  switch (request.method) {
    case 'initialize': reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, _meta: { steering: { supported: true } }, agentInfo: { name: 'live-steering-fixture', version: '1' } }); break;
    case 'session/new': reply({ sessionId: 'same-session' }); break;
    case 'session/load': reply({}); break;
    case 'session/prompt':
      active = request;
      if (process.argv[3] === 'tool') {
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'work-1', title: 'Preserve current work', kind: 'execute', status: 'in_progress' } } });
        setTimeout(() => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: request.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'work-1', status: 'completed' } } }), 150);
      }
      update(request.params.sessionId, 'original-work-in-flight');
      break;
    case '_session/steering':
      if (!active) { reply({ outcome: 'promptRequired', reason: 'noRunningTurn' }); break; }
      reply({ outcome: 'injected' });
      update(active.params.sessionId, `received:${request.params.prompt[0].text}`);
      fs.writeFileSync(`${root}/continued`, request.params.prompt[0].text);
      send({ jsonrpc: '2.0', id: active.id, result: { stopReason: 'end_turn' } });
      active = undefined;
      break;
    case 'session/cancel': if (active) send({ jsonrpc: '2.0', id: active.id, result: { stopReason: 'cancelled' } }); active = undefined; break;
    case 'session/close': reply({}); break;
    case 'session/set_mode': case 'session/set_config_option': reply({}); break;
    default: if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported method' } });
  }
});

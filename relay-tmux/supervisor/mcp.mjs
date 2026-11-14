#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { callSupervisor } from './ipc.mjs';
import { TOOLS } from './tools.mjs';

const identity = JSON.parse(await readFile(process.argv[2], 'utf8'));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.length > 100000) continue;
  let request; try { request = JSON.parse(line); } catch { continue; }
  if (request.id == null) continue;
  let result;
  try {
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'panecast_supervisor', version: '0.1.0' } };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/list') result = { tools: TOOLS };
    else if (request.method === 'tools/call') {
      const value = await callSupervisor(identity.connectionFile, 'tool', { managerId: identity.id, name: request.params?.name, arguments: request.params?.arguments ?? {} });
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue; }
  } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'tools/list') {
    await callSupervisor(identity.connectionFile, 'ready', { managerId: identity.id }).catch(() => {});
  }
}

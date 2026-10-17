#!/usr/bin/env -S node --no-warnings
// HTTP API + remote MCP endpoint.
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';

const port = Number(process.env.PORT ?? 8787);
const store = new Store({ dbPath: process.env.CONSUMABLES_DB ?? 'consumables.db' });
const server = await startServer(store, { port, baseUrl: process.env.PUBLIC_URL });
const { port: bound } = server.address();
console.log(`Consumables API on http://localhost:${bound}  (MCP: /mcp, docs: /llms.txt)`);

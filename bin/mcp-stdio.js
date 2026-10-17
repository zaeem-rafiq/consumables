#!/usr/bin/env -S node --no-warnings
// Local MCP server over stdio. Set CONSUMABLES_API_KEY to use an existing
// account; without it, call create_sandbox_account first.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store } from '../src/store.js';
import { buildMcpServer } from '../src/mcp.js';

const store = new Store({ dbPath: process.env.CONSUMABLES_DB ?? 'consumables.db' });
const server = buildMcpServer(store, { apiKey: process.env.CONSUMABLES_API_KEY });
await server.connect(new StdioServerTransport());

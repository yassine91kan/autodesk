// mcp/stdio.js
// ===========================================================================
// The same MCP server as routes/mcp.js, for Claude Desktop on this computer:
// Claude Desktop starts this file itself and talks to it over stdin/stdout,
// so no web server, public URL or MCP_KEY is needed.
//
// In Claude Desktop: Settings > Developer > Edit Config, then add under "mcpServers":
//   "aps-models": { "command": "<path to node.exe>", "args": ["<this folder>\\mcp\\stdio.js"] }
// ===========================================================================

const path = require('path');

// stdout carries the MCP messages: anything else printed there breaks them,
// so the project's console.log lines go to stderr (Claude Desktop's log) instead.
console.log = console.error;

// Claude Desktop starts us in its own folder; config.js reads .env from the current one.
process.chdir(path.join(__dirname, '..'));

const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { buildServer } = require('../routes/mcp.js');

buildServer().connect(new StdioServerTransport()).catch(error => {
    console.error('mcp stdio error:', error);
    process.exit(1);
});

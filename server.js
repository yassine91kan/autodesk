const express = require('express');
let app = express();
const bodyParser  = require('body-parser');

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Heroku forwards requests through its router: trust it, so the app sees https
// (for the secure cookie) and the visitor's real address (for the attempt limit).
app.set('trust proxy', 1);

// Render's health check (/healthz). Before sign-in: Render has no login cookie.
app.use(require('./routes/health.js'));

// The MCP server for AI chats (Claude, Copilot). Before sign-in: those apps can't
// use the login cookie, so it is protected by its secret address (MCP_KEY) instead.
app.use(require('./routes/mcp.js'));

// Sign-in first: nothing below (pages, files, APIs) is served without it.
app.use(require('./routes/login.js'));

// app.use(bodyParser.json());
// The pages at clean addresses: "/" = landing page, "/app" = the app (routes/pages.js).
app.use(require('./routes/pages.js'));
// Files (scripts, styles, images). index: false: "/" is the landing page now, not index.html.
app.use(express.static('wwwroot', { index: false }));
app.use(require('./routes/auth.js'));
app.use(require('./routes/models.js'));
app.use(require('./routes/admin.js'));   // /admin/questions: the question log, signed-in users only
// app.use(require('./routes/openai.js'));
// app.use(require('./routes/langchain.js'));
// Switched off (not deleted): the old LangChain chatbot ("Type 1" on the page, also
// commented out in wwwroot/index.html). Loading it built a vector store with OpenAI
// embeddings at every start, costing memory and startup time. Uncomment both to use it.
// app.use(require('./routes/langchain_great.js'));
// app.use(require('./routes/aps_agent_simple.js'));
// app.use(require('./routes/ask_agent_simple_claude.js'));
app.use(require('./routes/ask_agent_simple_v2.js'));
// app.use(require('./routes/agent_trial.js'));
// app.use(require('./routes/SQL.js'));
// app.use(require('./routes/geom_agent.js'));
// app.use(require('./routes/gis_agent.js'));
// app.use(require('./routes/solar_agent.js'));
// app.use(require('./routes/solar_technical_agent.js'));
// app.use(require('./routes/solar_agent_simulation.js'));
// app.use(require('./routes/rag_agent.js'));
// app.use(require('./routes/rag_agent_langgraph.js'));
// app.use(require('./routes/technical_agent_langgraph.js'));
// app.use(require('./routes/technical_agent_langgraph_supervisor.js'));
// app.use(require('./routes/rag_agent_langgraph_Chroma.js'));
// app.use(require('./routes/rag_llamaindex.js'));
// app.listen(PORT, function () { console.log(`Server listening on port ${PORT}...`); });
app.listen(process.env.PORT || 8080, function () { console.log(`Server listening on port ...`); });
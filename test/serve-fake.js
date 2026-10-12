// Starts v2 on port 3999 with the FAKE model and FAKE LLM (for trying eval.js
// without credentials). Your real server is what you point eval.js at normally.
process.env.ROUTER = '../routes/ask_agent_simple_v2.js';
const { app, origLog } = require('./harness');
app.listen(3999, () => origLog('Fake server on http://localhost:3999/api'));

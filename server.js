const express = require('express');
let app = express();
const bodyParser  = require('body-parser');

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// app.use(bodyParser.json());
app.use(express.static('wwwroot'));
app.use(require('./routes/auth.js'));
app.use(require('./routes/models.js'));
app.use(require('./routes/openai.js'));
app.use(require('./routes/langchain.js'));
// app.use(require('./routes/langchain_great.js'));
app.use(require('./routes/aps_agent_simple.js'));
app.use(require('./routes/ask_agent_simple.js'));
app.use(require('./routes/agent_trial.js'));
app.use(require('./routes/SQL.js'));
app.use(require('./routes/geom_agent.js'));
app.use(require('./routes/gis_agent.js'));
app.use(require('./routes/solar_agent.js'));
app.use(require('./routes/solar_technical_agent.js'));
app.use(require('./routes/solar_agent_simulation.js'));
// app.listen(PORT, function () { console.log(`Server listening on port ${PORT}...`); });
app.listen(process.env.PORT || 8080, function () { console.log(`Server listening on port ...`); });
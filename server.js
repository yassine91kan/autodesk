const express = require('express');
let app = express();
const bodyParser  = require('body-parser');



app.use(bodyParser.json());
app.use(express.static('wwwroot'));
app.use(require('./routes/auth.js'));
app.use(require('./routes/models.js'));
app.use(require('./routes/openai.js'));
app.use(require('./routes/openaifunc.js'));
// app.listen(PORT, function () { console.log(`Server listening on port ${PORT}...`); });
app.listen(process.env.PORT || 8080, function () { console.log(`Server listening on port ...`); });
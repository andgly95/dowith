const express = require('express');
const mount = require('./lib/routes');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

mount(app);

const PORT = Number(process.env.PORT) || 3006;
app.listen(PORT, () => console.log(`dowith listening on ${PORT}`));

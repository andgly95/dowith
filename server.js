const express = require('express');
const mount = require('./lib/routes');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

mount(app);

// The weekly digest sender. Does nothing until somebody has subscribed a device,
// so a fresh checkout stays quiet. NO_PUSH=1 keeps it out of test runs.
require('./lib/push').start();
// Cooking timers: due ones go out as a push to whoever started them.
require('./lib/timers').start(require('./store'), require('./lib/push').sendTo);

const PORT = Number(process.env.PORT) || 3006;
app.listen(PORT, () => console.log(`dowith listening on ${PORT}`));

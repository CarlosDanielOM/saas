// Only the fixture uses the installed reference server package, read-only.
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire('/home/dom/Projects/saas/dimabot/node_modules/noop.js');
const { Server } = require('socket.io');
const variant = process.env.VARIANT;
const server = http.createServer((req, res) => {
  if (req.url === '/miss') io.of('/test').emit('missed', 'offline');
  res.end('ok');
});
const io = new Server(server, variant === 'recovered' ? {} : {connectionStateRecovery: {maxDisconnectionDuration: 10000}});
io.of('/denied').use((_s, next) => {const e = new Error(variant === 'error-message' ? 'wrong' : 'denied'); e.data = {reason: variant === 'error-data' ? 'wrong' : 'auth'}; next(e);});
io.of('/test').on('connection', socket => {
  socket.on('burst', () => {
    const events = variant === 'order' ? ['second', 'first'] : ['first', 'second'];
    for (const event of events) {
      if (variant === 'missing' && event === 'second') continue;
      socket.emit(event, variant === 'argument' ? 'wrong' : 'héllo 👋');
    }
    if (variant === 'extra') socket.emit('extra', true);
  });
  socket.on('ack', (value, done) => done(variant === 'ack' ? 'wrong' : value, {ok: true}));
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => io.close(() => server.close(() => process.exit(0))));

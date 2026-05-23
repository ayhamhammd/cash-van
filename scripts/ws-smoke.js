/* eslint-disable */
// WebSocket smoke test for /ws/ops.
// Usage: node scripts/ws-smoke.js <token> [waitMs]
// Connects, prints received events, and reports refusal for a bad token.
const { io } = require('socket.io-client');

const token = process.argv[2];
const waitMs = parseInt(process.argv[3] || '4000', 10);

const socket = io('http://localhost:3000/ws/ops', {
  auth: { token },
  transports: ['websocket'],
  reconnection: false,
});

const received = [];
socket.on('connect', () => console.log('CONNECTED', socket.id));
socket.on('disconnect', (r) => console.log('DISCONNECTED', r));
socket.on('connect_error', (e) => console.log('CONNECT_ERROR', e.message));

['rep.location', 'invoice.created', 'invoice.confirmed', 'route.deviated', 'rep.offline'].forEach(
  (ev) => socket.on(ev, (p) => { received.push(ev); console.log('EVENT', ev, JSON.stringify(p)); }),
);

setTimeout(() => {
  console.log('RECEIVED_SUMMARY', JSON.stringify(received));
  socket.close();
  process.exit(0);
}, waitMs);

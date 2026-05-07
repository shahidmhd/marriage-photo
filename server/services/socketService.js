// socketService — a thin wrapper so other modules don't import socket.io directly.
// The HTTP server is created in index.js and handed in via attach().

const { Server } = require('socket.io');
const log = require('../utils/logger').make('socket');

let io = null;

function attach(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });
  io.on('connection', (socket) => {
    log.info('Client connected', { id: socket.id });
    socket.on('disconnect', () => log.info('Client disconnected', { id: socket.id }));
  });
  return io;
}

function emit(event, payload) {
  if (!io) return;
  io.emit(event, payload);
}

module.exports = { attach, emit };

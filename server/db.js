// MongoDB connection. We treat Mongo as the source of truth for image
// metadata; the HNSW index only stores raw vectors keyed by integer ids
// (`embeddingId`). The mapping embeddingId -> Image lives here.

const mongoose = require('mongoose');
const config = require('./config');
const log = require('./utils/logger').make('db');

let connected = false;

async function connect() {
  if (connected) return mongoose.connection;
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(config.mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    connected = true;
    log.info('Connected to MongoDB', { uri: redact(config.mongoUri) });
  } catch (err) {
    log.error('MongoDB connection failed — continuing without persistence', { err: err.message });
    // We deliberately do NOT throw: the in-memory cache in indexService
    // still lets the demo function. Reconnect logic can be added later.
  }
  return mongoose.connection;
}

function isConnected() {
  return connected && mongoose.connection.readyState === 1;
}

function redact(uri) {
  return uri.replace(/\/\/([^@]+)@/, '//***@');
}

module.exports = { connect, isConnected, mongoose };

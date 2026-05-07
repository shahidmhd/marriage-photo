// Server entry point. Boot order is important:
//   1. Connect Mongo (best-effort).
//   2. Initialize face-api models.
//   3. Initialize the HNSW index (which may hydrate from Mongo).
//   4. Wire Express + Socket.IO + the folder watcher.

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
const log = require('./utils/logger').make('server');
const db = require('./db');
const faceService = require('./services/faceService');
const indexService = require('./services/indexService');
const socketService = require('./services/socketService');
const uploadWatcher = require('./watchers/uploadWatcher');

const selfieRoutes = require('./routes/selfie');
const adminRoutes = require('./routes/admin');
const imageRoutes = require('./routes/images');

async function bootstrap() {
  for (const dir of [config.uploadsDir, config.selfiesDir, config.dataDir, config.modelsDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  await db.connect();
  await faceService.init();
  await indexService.init();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));

  // Serve uploaded photos and selfies as static files. In production, point
  // a CDN/S3 here instead.
  app.use('/uploads', express.static(config.uploadsDir, { maxAge: '7d' }));
  app.use('/selfies', express.static(config.selfiesDir, { maxAge: '1d' }));

  app.get('/api/health', (req, res) =>
    res.json({ ok: true, indexSize: indexService.size(), mongo: db.isConnected() })
  );

  app.use('/api', selfieRoutes);
  app.use('/api', adminRoutes);
  app.use('/api', imageRoutes);

  // Multer + generic error handler — keep this LAST.
  app.use((err, req, res, _next) => {
    log.error('Unhandled error', { err: err.message });
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = http.createServer(app);
  socketService.attach(server);
  uploadWatcher.start();

  server.listen(config.port, () => {
    log.info(`Server listening on http://localhost:${config.port}`);
    log.info(`Drop images into ${config.uploadsDir} to simulate the camera.`);
  });

  // Graceful shutdown so we always flush the index.
  const shutdown = (sig) => {
    log.info(`Received ${sig}, flushing index...`);
    try { indexService.save(); } catch (e) { log.error('Final save failed', { err: e.message }); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  log.error('Bootstrap failed', { err: err.message, stack: err.stack });
  process.exit(1);
});

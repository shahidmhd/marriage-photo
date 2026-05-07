// uploadWatcher — simulates a camera firehose by watching the uploads/ folder.
//
// Flow:
//   1. chokidar emits 'add' when a new file lands.
//   2. We enqueue an ingestion job (face detect → embed → index → persist).
//   3. After persistence, broadcast a `new_photo` event over Socket.IO so
//      connected clients can refresh.
//
// `ingestImage` is exported separately so the admin upload route can reuse
// the same code path without going through chokidar.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');

const config = require('../config');
const log = require('../utils/logger').make('watcher');
const faceService = require('../services/faceService');
const indexService = require('../services/indexService');
const queueService = require('../services/queueService');
const socketService = require('../services/socketService');

// Throttled persistence: writing the HNSW index after every photo is wasteful
// when the watcher is mid-burst. We mark dirty, then flush at most every 2s.
let dirty = false;
let flushTimer = null;
function markDirty() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    try {
      indexService.save();
      dirty = false;
      log.info('Index persisted', { size: indexService.size() });
    } catch (err) {
      log.error('Index persist failed', { err: err.message });
    }
  }, 2000);
}

// Track files we've already processed in this run so chokidar's `ignoreInitial: false`
// doesn't double-ingest if the watcher is restarted.
const seen = new Set();

function imageIdFor(filePath) {
  // Stable id derived from the filename; if you'd rather hash file contents,
  // swap this for a streamed sha256 — fine on small images, slow on huge ones.
  return path.basename(filePath);
}

async function ingestImage(filePath, opts = {}) {
  const id = imageIdFor(filePath);
  if (seen.has(id)) {
    log.debug('Already ingested, skipping', { id });
    return { skipped: true, imageId: id };
  }
  seen.add(id);

  return queueService.enqueue(`ingest:${id}`, async () => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File vanished before ingestion: ${filePath}`);
    }
    const t0 = Date.now();
    const faces = await faceService.detectFaces(filePath);
    const tDetect = Date.now() - t0;

    if (faces.length === 0) {
      log.warn('No faces detected', { id });
      socketService.emit('new_photo', {
        imageId: id,
        imageUrl: `/uploads/${path.basename(filePath)}`,
        faces: 0,
        eventId: opts.eventId || config.defaultEventId,
      });
      return { imageId: id, faces: 0 };
    }

    const baseMeta = {
      imageId: id,
      imageUrl: `/uploads/${path.basename(filePath)}`,
      eventId: opts.eventId || config.defaultEventId,
      createdAt: new Date(),
    };
    const ids = await indexService.addImageEmbeddings(faces, baseMeta);
    markDirty();

    const tTotal = Date.now() - t0;
    log.info('Image ingested', {
      id, faces: faces.length, embeddingIds: ids, detectMs: tDetect, totalMs: tTotal,
    });

    socketService.emit('new_photo', {
      imageId: id,
      imageUrl: baseMeta.imageUrl,
      faces: faces.length,
      eventId: baseMeta.eventId,
    });

    return { imageId: id, faces: faces.length, embeddingIds: ids };
  });
}

function start() {
  if (!fs.existsSync(config.uploadsDir)) fs.mkdirSync(config.uploadsDir, { recursive: true });

  const watcher = chokidar.watch(config.uploadsDir, {
    ignored: /(^|[\/\\])\../, // dotfiles (.gitkeep, .DS_Store, ...)
    persistent: true,
    ignoreInitial: false,      // process anything already sitting there
    awaitWriteFinish: {        // critical: don't read while a file is still being written
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on('add', (filePath) => {
    if (!/\.(jpe?g|png|webp)$/i.test(filePath)) return;
    ingestImage(filePath).catch((err) =>
      log.error('Ingest failed', { filePath, err: err.message })
    );
  });

  watcher.on('error', (err) => log.error('Watcher error', { err: err.message }));
  log.info('Watching uploads folder', { dir: config.uploadsDir });

  return watcher;
}

module.exports = { start, ingestImage };

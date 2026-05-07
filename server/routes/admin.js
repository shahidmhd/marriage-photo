// Admin routes — bulk-ingest images via HTTP (mirror of the folder-watcher path).
// Useful when you want to feed photos from a remote camera or a web admin UI.

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const log = require('../utils/logger').make('route:admin');
const { ingestImage } = require('../watchers/uploadWatcher');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(config.uploadsDir)) fs.mkdirSync(config.uploadsDir, { recursive: true });
    cb(null, config.uploadsDir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per photo
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpe?g|png|webp)$/i.test(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
    }
    cb(null, true);
  },
});

// POST /api/admin/upload — multipart, field name: "photos" (one or many)
//
// Fire-and-forget: face detection takes ~5-10s per image on a free-tier box
// and the queue is concurrency=1, so awaiting Promise.all for a 5-photo batch
// can run 30-60s — long enough for hosting proxies (Render's Cloudflare,
// Vercel's edge, etc.) to kill the upstream connection with a 502. We
// enqueue here and return immediately; the client tracks progress via the
// `new_photo` Socket.IO event emitted as each image finishes ingesting.
router.post('/admin/upload', upload.array('photos', 50), (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No files uploaded (field name: "photos")' });
  }
  const eventId = (req.body && req.body.eventId) || config.defaultEventId;

  for (const f of req.files) {
    ingestImage(f.path, { eventId }).catch((err) =>
      log.error('Ingest failed', { file: f.filename, err: err.message })
    );
  }

  log.info('Admin bulk upload queued', { count: req.files.length, eventId });
  res.json({ ok: true, eventId, queued: req.files.length });
});

module.exports = router;

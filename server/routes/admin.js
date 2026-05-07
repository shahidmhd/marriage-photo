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
router.post('/admin/upload', upload.array('photos', 50), async (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No files uploaded (field name: "photos")' });
  }
  const eventId = (req.body && req.body.eventId) || config.defaultEventId;

  // Files are already saved to uploadsDir, which the chokidar watcher is
  // observing — but waiting on chokidar would make the response racy. We
  // explicitly enqueue ingestion here and return the job count.
  const jobs = req.files.map((f) =>
    ingestImage(f.path, { eventId }).catch((err) => ({ error: err.message, file: f.filename }))
  );

  try {
    const results = await Promise.all(jobs);
    log.info('Admin bulk upload complete', { count: results.length, eventId });
    res.json({ ok: true, eventId, results });
  } catch (err) {
    log.error('Admin upload failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Read-only routes for browsing what's been indexed. Handy for the admin
// page and for verifying the watcher is doing its job.

const express = require('express');
const Image = require('../models/Image');
const indexService = require('../services/indexService');
const queueService = require('../services/queueService');
const db = require('../db');

const router = express.Router();

// GET /api/images?eventId=... — list distinct images
router.get('/images', async (req, res) => {
  const { eventId, limit = 50 } = req.query;
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  try {
    if (db.isConnected()) {
      const filter = eventId ? { eventId } : {};
      const docs = await Image.aggregate([
        { $match: filter },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: '$imageId',
            imageUrl: { $first: '$imageUrl' },
            eventId: { $first: '$eventId' },
            faces: { $sum: 1 },
            createdAt: { $first: '$createdAt' },
          },
        },
        { $sort: { createdAt: -1 } },
        { $limit: lim },
      ]);
      return res.json({ ok: true, count: docs.length, images: docs });
    }
    // No Mongo: nothing pretty to return without scanning the metadata cache.
    res.json({ ok: true, count: 0, images: [], warning: 'MongoDB not connected; listing unavailable.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — index health, queue depth, mongo state
router.get('/stats', (req, res) => {
  res.json({
    ok: true,
    indexSize: indexService.size(),
    queue: queueService.stats(),
    mongoConnected: db.isConnected(),
  });
});

module.exports = router;

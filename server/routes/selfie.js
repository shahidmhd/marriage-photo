// POST /api/upload-selfie
// Accepts a single image, runs face detection, queries the HNSW index,
// and returns the top-K matching event photos.

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const log = require('../utils/logger').make('route:selfie');
const faceService = require('../services/faceService');
const indexService = require('../services/indexService');

const router = express.Router();

// Store selfies on disk so we can show them back if desired. We don't index
// them — selfies are query-only.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(config.selfiesDir)) fs.mkdirSync(config.selfiesDir, { recursive: true });
    cb(null, config.selfiesDir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpe?g|png|webp)$/i.test(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
    }
    cb(null, true);
  },
});

router.post('/upload-selfie', upload.single('selfie'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No selfie uploaded (field name: "selfie")' });

  const { eventId, topK, threshold } = req.body || {};
  const filePath = req.file.path;

  try {
    const t0 = Date.now();
    const face = await faceService.detectPrimaryFace(filePath);
    const tDetect = Date.now() - t0;
    if (!face) {
      return res.status(422).json({ error: 'No face detected in selfie. Please try a clearer photo.' });
    }

    // Build user-facing warnings from the quality signals. We surface them
    // alongside results rather than blocking the search — the user might be
    // experimenting and want to see what comes back even from a poor selfie.
    const warnings = [];
    if (face.quality?.faceTooSmall) {
      const box = face.quality.faceBox || {};
      const pct = ((face.quality.faceFractionOfImage || 0) * 100).toFixed(1);
      warnings.push({
        code: 'face_too_small',
        title: 'Face is too small in the photo',
        message:
          `The detected face is only ${box.width || '?'}×${box.height || '?'} pixels (about ${pct}% of the image). ` +
          `This looks like a wide-angle / full-body shot rather than a selfie. ` +
          `The recognition network needs roughly a 150×150 face crop to produce a reliable descriptor — below that, the embedding becomes noisy and the top matches end up being whoever is most heavily indexed, not whoever you actually look like. ` +
          `Re-upload a close-up of your face that fills most of the frame.`,
      });
    }
    if (face.quality?.eyesOccluded) {
      warnings.push({
        code: 'eyes_occluded',
        title: 'Eyes appear obscured',
        message:
          'Your selfie looks like it has sunglasses, a hat brim, or heavy shadow over the eyes. The eye region is the most distinctive part of a face descriptor — without it, matches collapse toward anyone with a similar jaw or hair, producing confident-looking but wrong results. Re-upload a photo with eyes clearly visible for accurate matches.',
      });
    }
    if (face.quality?.detectionScore != null && face.quality.detectionScore < 0.7) {
      warnings.push({
        code: 'low_detection_confidence',
        title: 'Low face-detection confidence',
        message: `The detector found a face with only ${(face.quality.detectionScore * 100).toFixed(0)}% confidence. A clearer, well-lit, front-facing photo will give more reliable matches.`,
      });
    }

    const t1 = Date.now();
    const matches = indexService.search(face.descriptor, {
      topK: topK ? parseInt(topK, 10) : config.match.topK,
      eventId: eventId || undefined,
      distanceThreshold: threshold ? parseFloat(threshold) : config.match.distanceThreshold,
    });
    const tSearch = Date.now() - t1;

    log.info('Selfie matched', {
      indexSize: indexService.size(),
      matches: matches.length,
      detectMs: tDetect,
      searchMs: tSearch,
      warnings: warnings.map((w) => w.code),
    });

    res.json({
      ok: true,
      query: { eventId: eventId || null, topK: topK || config.match.topK, threshold: threshold || config.match.distanceThreshold },
      timings: { detectMs: tDetect, searchMs: tSearch },
      warnings,
      selfieQuality: face.quality,
      matches,
    });
  } catch (err) {
    log.error('Selfie matching failed', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

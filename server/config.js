// Centralized configuration. Reads from .env with sensible defaults so the
// server can boot in dev without any setup beyond `npm install`.

require('dotenv').config();
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const config = {
  rootDir: ROOT,
  port: parseInt(process.env.PORT, 10) || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',

  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/wedding_face_match',

  uploadsDir: abs(process.env.UPLOADS_DIR || 'uploads'),
  selfiesDir: abs(process.env.SELFIES_DIR || 'selfies'),
  modelsDir: abs(process.env.MODELS_DIR || 'models'),
  dataDir: abs(process.env.DATA_DIR || 'data'),

  hnsw: {
    dim: parseInt(process.env.HNSW_DIM, 10) || 128,
    maxElements: parseInt(process.env.HNSW_MAX_ELEMENTS, 10) || 50000,
    efConstruction: parseInt(process.env.HNSW_EF_CONSTRUCTION, 10) || 200,
    M: parseInt(process.env.HNSW_M, 10) || 16,
    efSearch: parseInt(process.env.HNSW_EF_SEARCH, 10) || 100,
    space: 'l2',
    indexFile: 'face.index',
    metaFile: 'face.meta.json',
  },

  match: {
    // 0.273 L2 distance corresponds to "strictly above 80%" in the rounded
    // similarity badge (similarity > 80.5% → displays as 81% or higher).
    // The 0.005 offset over 0.28 (= exact 80% similarity) handles the
    // Math.round() boundary so a match that prints as "80%" gets cut.
    // We default strict because event-photo matching is privacy-sensitive:
    // showing a guest a stranger's photos is worse than missing a few real
    // matches. The UI can dial it per-query if needed.
    distanceThreshold: parseFloat(process.env.MATCH_DISTANCE_THRESHOLD) || 0.273,
    topK: parseInt(process.env.MATCH_TOP_K, 10) || 20,
  },

  defaultEventId: process.env.DEFAULT_EVENT_ID || 'default-event',
};

module.exports = config;

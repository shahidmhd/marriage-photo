// indexService — owns the HNSW index + the embeddingId->metadata mapping.
//
// Why both? hnswlib-node stores raw vectors keyed by integer ids. We need a
// sidecar so that, given a query result like {id: 423, distance: 0.31}, we
// can look up which image/face that id belongs to.
//
// Persistence layout (in `config.dataDir`):
//   face.index       — binary HNSW dump (writeIndex/readIndex)
//   face.meta.json   — { nextId, items: { [embeddingId]: <metadata> } }
//
// MongoDB is the durable source of truth when available; the JSON sidecar
// keeps the demo runnable with no Mongo at all.

const fs = require('fs');
const path = require('path');
const hnswlib = require('hnswlib-node');

const config = require('../config');
const log = require('../utils/logger').make('index');
const Image = require('../models/Image');
const db = require('../db');

const INDEX_PATH = path.join(config.dataDir, config.hnsw.indexFile);
const META_PATH = path.join(config.dataDir, config.hnsw.metaFile);

let index = null;
let nextId = 0;
// In-memory cache of embeddingId -> metadata. Hot path for search results,
// rebuilt from Mongo (or the JSON sidecar) at startup.
const meta = new Map();

function ensureDataDir() {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
}

async function init() {
  ensureDataDir();
  index = new hnswlib.HierarchicalNSW(config.hnsw.space, config.hnsw.dim);

  if (fs.existsSync(INDEX_PATH)) {
    log.info('Loading HNSW index from disk', { path: INDEX_PATH });
    // Sync variant — readIndex (the async overload) returns a Promise that we'd
    // have to await; readIndexSync is simpler and the blocking time is negligible
    // for indices below ~100k vectors.
    index.readIndexSync(INDEX_PATH, true /* allowReplaceDeleted */);
    index.setEf(config.hnsw.efSearch);
  } else {
    log.info('Initializing fresh HNSW index', { ...config.hnsw });
    index.initIndex(config.hnsw.maxElements, config.hnsw.M, config.hnsw.efConstruction);
    index.setEf(config.hnsw.efSearch);
  }

  // Restore metadata. Prefer Mongo, fall back to JSON sidecar.
  if (db.isConnected()) {
    log.info('Hydrating metadata cache from MongoDB');
    const docs = await Image.find({}).lean();
    for (const d of docs) {
      meta.set(d.embeddingId, {
        embeddingId: d.embeddingId,
        imageId: d.imageId,
        imageUrl: d.imageUrl,
        faceIndex: d.faceIndex,
        faceBox: d.faceBox,
        eventId: d.eventId,
        createdAt: d.createdAt,
      });
    }
    nextId = docs.reduce((m, d) => Math.max(m, d.embeddingId + 1), 0);
    log.info('Hydrated from Mongo', { count: docs.length, nextId });
  } else if (fs.existsSync(META_PATH)) {
    log.info('Hydrating metadata cache from JSON sidecar');
    const raw = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    nextId = raw.nextId || 0;
    for (const [k, v] of Object.entries(raw.items || {})) {
      meta.set(parseInt(k, 10), v);
    }
    log.info('Hydrated from JSON', { count: meta.size, nextId });
  }
}

/**
 * Insert one descriptor into the index, return the assigned embeddingId.
 * @param {Float32Array|number[]} descriptor
 * @param {object} metadata - {imageId, imageUrl, faceIndex, faceBox, eventId}
 */
async function addEmbedding(descriptor, metadata) {
  if (!index) throw new Error('indexService not initialized');

  // hnswlib-node expects a plain number[]; Float32Array works in newer versions
  // but converting is cheap and bulletproof.
  const vec = Array.from(descriptor);
  if (vec.length !== config.hnsw.dim) {
    throw new Error(`Descriptor dimension mismatch: got ${vec.length}, expected ${config.hnsw.dim}`);
  }

  const embeddingId = nextId++;
  index.addPoint(vec, embeddingId);

  const record = {
    embeddingId,
    imageId: metadata.imageId,
    imageUrl: metadata.imageUrl,
    faceIndex: metadata.faceIndex || 0,
    faceBox: metadata.faceBox,
    eventId: metadata.eventId || config.defaultEventId,
    createdAt: metadata.createdAt || new Date(),
  };
  meta.set(embeddingId, record);

  if (db.isConnected()) {
    // Fire-and-forget — we don't want Mongo latency in the watcher's hot path.
    Image.create(record).catch((err) => log.error('Mongo write failed', { err: err.message }));
  }

  return embeddingId;
}

/**
 * Add many embeddings from a single image atomically.
 * Returns the list of assigned embeddingIds in face-detection order.
 */
async function addImageEmbeddings(faces, baseMeta) {
  const ids = [];
  for (let i = 0; i < faces.length; i++) {
    const id = await addEmbedding(faces[i].descriptor, {
      ...baseMeta,
      faceIndex: i,
      faceBox: faces[i].box,
    });
    ids.push(id);
  }
  return ids;
}

/**
 * Search the K nearest neighbors of a query descriptor.
 * Filters by eventId if provided and dedupes by imageId.
 *
 * @returns {Array<{imageId, imageUrl, distance, similarity, eventId, matchedFaces}>}
 */
function search(descriptor, { topK, eventId, distanceThreshold } = {}) {
  if (!index) throw new Error('indexService not initialized');
  if (meta.size === 0) return [];

  const k = Math.min(topK || config.match.topK, meta.size);
  const threshold = distanceThreshold ?? config.match.distanceThreshold;
  const vec = Array.from(descriptor);

  // hnswlib-node returns { neighbors: number[], distances: number[] }
  // We over-fetch a bit so post-filtering by eventId/threshold still leaves K.
  const overFetch = Math.min(k * 4, meta.size);
  const raw = index.searchKnn(vec, overFetch);

  const byImage = new Map();
  for (let i = 0; i < raw.neighbors.length; i++) {
    const id = raw.neighbors[i];
    const distance = raw.distances[i];
    if (distance > threshold) continue;

    const m = meta.get(id);
    if (!m) continue; // index entry without metadata (shouldn't happen)
    if (eventId && m.eventId !== eventId) continue;

    const existing = byImage.get(m.imageId);
    if (!existing || distance < existing.distance) {
      byImage.set(m.imageId, {
        imageId: m.imageId,
        imageUrl: m.imageUrl,
        eventId: m.eventId,
        distance,
        // Convert L2 distance to a 0..1 similarity score. face-api descriptors
        // are L2-normalized so distances roughly live in [0, 1.4].
        similarity: Math.max(0, 1 - distance / 1.4),
        matchedFaces: [{ embeddingId: id, faceIndex: m.faceIndex, distance }],
        createdAt: m.createdAt,
      });
    } else {
      existing.matchedFaces.push({ embeddingId: id, faceIndex: m.faceIndex, distance });
    }
  }

  return Array.from(byImage.values())
    .sort((a, b) => a.distance - b.distance)
    .slice(0, k);
}

/**
 * Persist the index + metadata sidecar to disk. Safe to call frequently;
 * we throttle in the watcher so disk IO doesn't pile up.
 */
function save() {
  ensureDataDir();
  // writeIndexSync — keeps the watcher's debounced flush synchronous so we
  // don't have to plumb async through it. For indices below ~100k vectors
  // this completes in single-digit milliseconds.
  index.writeIndexSync(INDEX_PATH);
  const items = {};
  for (const [k, v] of meta.entries()) items[k] = v;
  fs.writeFileSync(META_PATH, JSON.stringify({ nextId, items }, null, 2));
}

function size() {
  return meta.size;
}

module.exports = {
  init,
  addEmbedding,
  addImageEmbeddings,
  search,
  save,
  size,
};

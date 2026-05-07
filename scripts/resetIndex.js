// Wipe the HNSW index, the JSON sidecar, and the MongoDB image metadata so
// the next server run starts from a clean slate. Useful after changing
// detector/threshold settings, since existing embeddings were computed under
// the old config.
//
// Usage:  node scripts/resetIndex.js [--keep-uploads]
//
// By default this also re-triggers ingestion by `touch`-ing every file in
// uploads/ once you restart the server (so the watcher picks them up again).
// Pass --keep-uploads to leave uploads/ alone.

const fs = require('fs');
const path = require('path');
const config = require('../server/config');
const mongoose = require('mongoose');

const KEEP_UPLOADS = process.argv.includes('--keep-uploads');

function rm(p) {
  try { fs.unlinkSync(p); console.log('  removed', p); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

(async () => {
  console.log('Resetting index state in', config.dataDir);
  rm(path.join(config.dataDir, config.hnsw.indexFile));
  rm(path.join(config.dataDir, config.hnsw.metaFile));

  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 3000 });
    const result = await mongoose.connection.db.collection('images').deleteMany({});
    console.log(`  cleared ${result.deletedCount} Mongo docs`);
    await mongoose.disconnect();
  } catch (err) {
    console.log('  Mongo not reachable, skipping (', err.message, ')');
  }

  if (!KEEP_UPLOADS) {
    // Don't delete files — just bump mtime so chokidar's awaitWriteFinish
    // re-fires `add` on next server start.
    const files = fs.readdirSync(config.uploadsDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
    const now = new Date();
    for (const f of files) {
      fs.utimesSync(path.join(config.uploadsDir, f), now, now);
    }
    console.log(`  touched ${files.length} files in uploads/ for re-ingestion`);
  }

  console.log('\nDone. Restart the server (`npm run dev`) to re-ingest.');
})();

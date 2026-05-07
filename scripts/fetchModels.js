// Downloads the face-api.js model files into ./models so the server can
// boot offline thereafter. The canonical models are mirrored in the
// face-api.js GitHub repo under weights/.
//
// Usage:  npm run fetch:models

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(ROOT, 'models');

// We need three networks: ssd_mobilenetv1 (detector), face_landmark_68 (alignment),
// and face_recognition (descriptor). Each network ships a -shardN.bin per ~4MB chunk.
const BASE = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/';
const FILES = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model-shard1',
  'ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2',
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.partial`;
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, (res) => {
      // Follow one level of redirect — GitHub raw is direct, but be safe.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(tmp);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(tmp);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        fs.renameSync(tmp, dest);
        resolve();
      }));
    });
    req.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      reject(err);
    });
  });
}

(async () => {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  for (const name of FILES) {
    const dest = path.join(MODELS_DIR, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`✓ ${name} (cached)`);
      continue;
    }
    process.stdout.write(`↓ ${name}... `);
    try {
      await download(BASE + name, dest);
      console.log('done');
    } catch (err) {
      console.error('FAILED', err.message);
      process.exit(1);
    }
  }
  console.log('\nAll model files saved to', MODELS_DIR);
})();

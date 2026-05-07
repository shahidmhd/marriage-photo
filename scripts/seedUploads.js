// Smoke test: copies any *.jpg/*.png files from a source folder into uploads/.
// Useful for spinning the watcher with a known set of photos.
//
// Usage:  node scripts/seedUploads.js /path/to/photos

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'uploads');
const src = process.argv[2];

if (!src) {
  console.error('Usage: node scripts/seedUploads.js <source-dir>');
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error('Source directory not found:', src);
  process.exit(1);
}
if (!fs.existsSync(DEST)) fs.mkdirSync(DEST, { recursive: true });

const files = fs.readdirSync(src).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
console.log(`Copying ${files.length} files to ${DEST} (one per second to avoid burst)...`);

let i = 0;
function next() {
  if (i >= files.length) {
    console.log('Done.');
    return;
  }
  const f = files[i++];
  const dest = path.join(DEST, `${Date.now()}-${f}`);
  fs.copyFileSync(path.join(src, f), dest);
  console.log('  +', path.basename(dest));
  setTimeout(next, 1000);
}
next();

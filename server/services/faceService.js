// faceService — wraps face-api.js for Node.
//
// Responsibilities:
//   1. Load TF + face-api models exactly once (lazy init).
//   2. Decode image buffers via node-canvas.
//   3. Detect faces and return 128-d descriptors + bounding boxes.
//
// Model files must live in `config.modelsDir` (see scripts/fetchModels.js).

const path = require('path');
const fs = require('fs');

// We use @vladmandic/face-api — a maintained, API-compatible fork of
// face-api.js with current TF.js. It ships multiple pre-built bundles; we
// pick one at runtime:
//
//   1. If @tensorflow/tfjs-node is installed (optional speed-up, requires a
//      native build), bind to the dedicated `face-api.node` build for
//      maximum throughput.
//   2. Otherwise fall back to `face-api.node-wasm` + the WASM TF backend.
//      This is pure JS/WASM, has no native compile step, and avoids the
//      path-with-spaces issues that plague tfjs-node's gyp fallback.
let backend;
let faceapi;
try {
  require('@tensorflow/tfjs-node');
  // eslint-disable-next-line global-require
  faceapi = require('@vladmandic/face-api/dist/face-api.node.js');
  backend = 'tfjs-node (native)';
} catch (_e) {
  // eslint-disable-next-line global-require
  require('@tensorflow/tfjs');
  // eslint-disable-next-line global-require
  faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
  backend = 'tfjs-backend-wasm';
}
const canvas = require('canvas');

const config = require('../config');
const log = require('../utils/logger').make('face');

// Patch face-api with node-canvas implementations of HTMLImage/Canvas.
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

let initPromise = null;

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const dir = config.modelsDir;
    if (!fs.existsSync(dir)) {
      throw new Error(`Models directory not found: ${dir}. Run \`npm run fetch:models\`.`);
    }

    // For the WASM backend we have to point TF at the .wasm files inside
    // node_modules (since we're not running in a browser with auto-fetch)
    // and explicitly switch the backend on. The native build self-registers.
    if (backend === 'tfjs-backend-wasm') {
      const { setWasmPaths } = require('@tensorflow/tfjs-backend-wasm');
      const wasmDir = path.join(
        require.resolve('@tensorflow/tfjs-backend-wasm/package.json'),
        '..', 'dist', '/'
      );
      setWasmPaths(wasmDir);
      await faceapi.tf.setBackend('wasm');
      await faceapi.tf.ready();
    }

    log.info('Loading face-api models', { dir, backend });
    // SsdMobilenetv1 is more accurate than TinyFaceDetector for event photos
    // where faces are often small / partially occluded.
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(dir);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(dir);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(dir);
    log.info('Models loaded');
  })();
  return initPromise;
}

/**
 * Detect every face in an image and return descriptors.
 * @param {string} imagePath - absolute path to the image on disk
 * @returns {Promise<Array<{descriptor: Float32Array, box: {x,y,width,height}}>>}
 */
async function detectFaces(imagePath) {
  await init();

  // Load and decode the image. node-canvas handles jpg/png/webp.
  const img = await canvas.loadImage(imagePath);

  // detectAllFaces -> landmarks -> descriptors gives us per-face 128-d vectors.
  const detections = await faceapi
    .detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  return detections.map((d) => ({
    descriptor: d.descriptor, // Float32Array(128)
    box: {
      x: Math.round(d.detection.box.x),
      y: Math.round(d.detection.box.y),
      width: Math.round(d.detection.box.width),
      height: Math.round(d.detection.box.height),
    },
    score: d.detection.score,
  }));
}

/**
 * Sample pixel statistics inside a polygon of landmark points. Used to
 * heuristically detect eye occlusion (sunglasses, hat brims, low light).
 *
 * The eye region is the most discriminative part of a face descriptor:
 * iris, sclera, and lashes contribute most of the per-person variance the
 * 128-d embedding captures. When that region is covered, the descriptor
 * collapses toward whoever has similar lower-face features — producing
 * confident-looking but wrong matches.
 *
 * Signal we use:
 *   - **Variance** of luminance across the eye bounding box.
 *     Bare eyes: high variance from sclera/iris/lash contrast.
 *     Sunglasses lens: near-uniform color → very low variance.
 *   - **Mean luminance** as a sanity check (sunglasses are usually dark).
 *
 * Returns null if the region is too small to sample reliably.
 */
function eyeRegionStats(ctx, points, imgW, imgH) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // Expand the bbox by 25% so we capture the lens / brow area, not just the
  // tight outline of the eye landmarks (which sit ON the eye, not around it).
  const w0 = maxX - minX;
  const h0 = maxY - minY;
  const pad = 0.25;
  const x0 = Math.max(0, Math.floor(minX - w0 * pad));
  const y0 = Math.max(0, Math.floor(minY - h0 * pad));
  const x1 = Math.min(imgW, Math.ceil(maxX + w0 * pad));
  const y1 = Math.min(imgH, Math.ceil(maxY + h0 * pad));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 5 || h < 5) return null;

  const data = ctx.getImageData(x0, y0, w, h).data;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    // ITU-R BT.709 luma coefficients.
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += lum;
    sumSq += lum * lum;
    n += 1;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return { mean, variance, samples: n };
}

function assessSelfieQuality(image, landmarks, detection) {
  // Draw to a temp canvas so we can sample pixels.
  const c = canvas.createCanvas(image.width, image.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(image, 0, 0);

  const left = eyeRegionStats(ctx, landmarks.getLeftEye(), image.width, image.height);
  const right = eyeRegionStats(ctx, landmarks.getRightEye(), image.width, image.height);

  // --- Eye-occlusion (sunglasses / hat brim) heuristic --------------------
  // Empirically tuned variance/mean thresholds:
  //   - bare eyes: variance typically 600-2500, mean 80-180
  //   - sunglasses: variance typically <150, mean <60
  //   - dark eyebrows / shadow: variance ~300-500, mean ~70-110 (borderline)
  const VAR_THRESHOLD = 250;
  const MEAN_THRESHOLD = 90;
  const looksOccluded = (s) =>
    s && s.variance < VAR_THRESHOLD && s.mean < MEAN_THRESHOLD;

  // Require BOTH eyes to look occluded before flagging — otherwise we'd
  // false-positive on people with one eye in shadow.
  const eyesOccluded = looksOccluded(left) && looksOccluded(right);

  // --- Face-too-small heuristic ------------------------------------------
  // The recognition net wants ~150×150 aligned face crops. If the bbox is
  // way smaller than that (typical for "selfie" photos that are actually
  // wide shots / full-body / distant figures), the descriptor is noise and
  // matches collapse onto whichever index entries happen to be nearby in
  // a generic region of face-space.
  const box = detection.box;
  const faceWidth = box.width;
  const faceHeight = box.height;
  const minSide = Math.min(faceWidth, faceHeight);
  const imgArea = image.width * image.height;
  const faceFraction = (faceWidth * faceHeight) / imgArea;
  // Absolute face size is what governs descriptor reliability — the
  // recognition net resizes the crop to 150×150 internally, so anything
  // under ~80px on its short side is upsampling noise.
  // We do NOT add a "fraction of image" check, because high-resolution
  // phone photos can have a perfectly fine 131×175 face that's still <2%
  // of a 4032×3024 frame. Fraction false-positives on close-ups.
  const faceTooSmall = minSide < 80;

  return {
    eyesOccluded,
    left,
    right,
    faceTooSmall,
    faceBox: {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(faceWidth),
      height: Math.round(faceHeight),
    },
    faceFractionOfImage: faceFraction,
    imageDims: { width: image.width, height: image.height },
  };
}

/**
 * Detect only the highest-confidence face (used for selfie queries).
 * Returns null if no face is found. Includes a `quality` block with
 * detection confidence + occlusion heuristics, so the API layer can
 * surface actionable feedback to the user when results would be unreliable.
 */
async function detectPrimaryFace(imagePath) {
  await init();
  const img = await canvas.loadImage(imagePath);
  const detection = await faceapi
    .detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return null;

  let quality;
  try {
    const q = assessSelfieQuality(img, detection.landmarks, detection.detection);
    quality = {
      detectionScore: detection.detection.score,
      eyesOccluded: q.eyesOccluded,
      faceTooSmall: q.faceTooSmall,
      faceBox: q.faceBox,
      faceFractionOfImage: q.faceFractionOfImage,
      imageDims: q.imageDims,
      leftEye: q.left,
      rightEye: q.right,
    };
  } catch (err) {
    log.warn('Quality assessment failed; continuing without it', { err: err.message });
    quality = { detectionScore: detection.detection.score, eyesOccluded: false, faceTooSmall: false };
  }

  return {
    descriptor: detection.descriptor,
    box: detection.detection.box,
    score: detection.detection.score,
    quality,
  };
}

module.exports = { init, detectFaces, detectPrimaryFace };

# Wedding Face Match

A production-shaped MVP for face-recognition photo matching at events.
Drop photos into `uploads/` (or POST to the admin endpoint), let guests upload
a selfie, and the system returns every photo they appear in — typically in
under 100ms once the index is warm.

## Architecture

```
   uploads/  ─chokidar─▶  queue ─▶  faceService (face-api.js + tfjs-node)
                                        │
                                        ▼
                                   indexService (HNSW, hnswlib-node)
                                        │   │
                                        │   └────▶  data/face.index  (persistence)
                                        ▼
                                    MongoDB    (image metadata, optional)
                                        │
                                        ▼
                                    Socket.IO  ──▶  Next.js client
```

- **Backend** (`server/`): Express, `@vladmandic/face-api` (maintained fork of face-api.js, with bundled TF.js), hnswlib-node, Socket.IO, MongoDB.
- **Frontend** (`client/`): Next.js (pages router) with a guest page and an admin page.
- **Index**: HNSW with `space=l2`, `dim=128`, `M=16`, `efConstruction=200`, `efSearch=100`.
- **Persistence**: index dumped to `data/face.index`; metadata in MongoDB (with a JSON sidecar fallback so the demo runs without Mongo).

## Quick start

### 1. Prerequisites

- Node.js 18+ (LTS recommended)
- macOS, Linux, or WSL2 — `@tensorflow/tfjs-node` and `canvas` need native build tooling
- (Optional) MongoDB running on `mongodb://127.0.0.1:27017`

If `npm install` fails on `canvas`, install the system deps:

```bash
# macOS
brew install pkg-config cairo pango libpng jpeg giflib librsvg

# Debian/Ubuntu
sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
```

### 2. Install dependencies

```bash
cp .env.example .env       # tweak as needed
npm run install:all        # installs server + client deps
```

### 3. Download face-api models (~13 MB)

```bash
npm run fetch:models
```

This populates `models/` with the SSD MobileNet v1 detector, the 68-point
landmark model, and the FaceNet recognition model.

### 4. Run

```bash
# one terminal — concurrent server + client
npm run dev

# or in two terminals
npm run server     # http://localhost:4000
npm run client     # http://localhost:3000
```

### 5. Test the camera flow

Drop a few JPEGs into `uploads/`:

```bash
cp ~/Pictures/event/*.jpg uploads/
# or feed a folder one-per-second:
node scripts/seedUploads.js ~/Pictures/event
```

You'll see ingestion logs in the server terminal, and the Admin page
(`/admin`) will show photos arriving in the live feed.

### 6. Match a selfie

Open `http://localhost:3000`, upload a selfie that contains a face from one
of the ingested photos, and you'll get a grid of matches with similarity
scores.

Or curl it:

```bash
curl -F selfie=@/path/to/me.jpg \
     -F eventId=default-event \
     -F threshold=0.5 \
     -F topK=10 \
     http://localhost:4000/api/upload-selfie
```

## API

| Method | Path                         | Description |
|--------|------------------------------|-------------|
| POST   | `/api/upload-selfie`         | Multipart `selfie`. Optional `eventId`, `topK`, `threshold`. Returns top-K matched images. |
| POST   | `/api/admin/upload`          | Multipart `photos[]` + `eventId`. Bulk-ingest event photos. |
| GET    | `/api/images?eventId=...`    | List indexed images (requires Mongo). |
| GET    | `/api/stats`                 | Index size, queue depth, Mongo state. |
| GET    | `/api/health`                | Liveness check. |
| WS     | `socket.io`                  | Emits `new_photo` whenever a photo finishes indexing. |

### Match response shape

```json
{
  "ok": true,
  "query": { "eventId": "default-event", "topK": 10, "threshold": 0.5 },
  "timings": { "detectMs": 84, "searchMs": 3 },
  "matches": [
    {
      "imageId": "1715000000000-IMG_0123.jpg",
      "imageUrl": "/uploads/1715000000000-IMG_0123.jpg",
      "eventId": "default-event",
      "distance": 0.31,
      "similarity": 0.78,
      "matchedFaces": [{ "embeddingId": 423, "faceIndex": 0, "distance": 0.31 }],
      "createdAt": "2026-05-07T12:00:00.000Z"
    }
  ]
}
```

## Tuning

`.env` knobs (all optional):

| Var | Purpose | Default |
|-----|---------|---------|
| `HNSW_DIM`               | Descriptor dimensionality (face-api emits 128) | 128 |
| `HNSW_MAX_ELEMENTS`      | Pre-allocated index capacity                   | 50000 |
| `HNSW_M`                 | Graph connectivity (build memory ↔ recall)    | 16 |
| `HNSW_EF_CONSTRUCTION`   | Build-time exploration                         | 200 |
| `HNSW_EF_SEARCH`         | Query-time exploration (recall ↔ latency)     | 100 |
| `MATCH_DISTANCE_THRESHOLD` | Reject matches above this L2 distance        | 0.5 |
| `MATCH_TOP_K`            | Default K for selfie queries                   | 10 |
| `QUEUE_CONCURRENCY`      | Parallel face-api inferences                   | 1 |

Practical guidance:

- **Recall vs latency**: increase `efSearch` for better recall at the cost of query time.
- **Threshold**: 0.5 is a strong match, 0.6 is permissive (more false positives), 0.4 is strict.
- **Concurrency**: tfjs-node uses native threads internally — bump `QUEUE_CONCURRENCY` only if you've benchmarked your hardware.

## Project layout

```
.
├── server/
│   ├── index.js                 # Express + Socket.IO + watcher boot
│   ├── config.js                # env-driven config
│   ├── db.js                    # Mongo connection (best-effort)
│   ├── models/Image.js          # one doc per (image, face)
│   ├── services/
│   │   ├── faceService.js       # face-api.js wrapper
│   │   ├── indexService.js      # HNSW + metadata cache + persistence
│   │   ├── queueService.js      # p-queue worker queue
│   │   └── socketService.js     # Socket.IO singleton
│   ├── watchers/uploadWatcher.js
│   ├── routes/{selfie,admin,images}.js
│   └── utils/logger.js
├── client/                      # Next.js (pages router)
│   ├── pages/{index,admin,_app}.js
│   ├── components/{UploadForm,MatchGrid}.js
│   └── styles/globals.css
├── scripts/{fetchModels,seedUploads}.js
├── models/                      # face-api weights (downloaded)
├── uploads/                     # camera simulation drop folder
├── selfies/                     # uploaded selfies
└── data/                        # face.index + face.meta.json
```

## Production notes

- Swap `selfiesDir` / `uploadsDir` for S3/Cloudinary by replacing the multer disk storage and the `imageUrl` builder in `uploadWatcher.js`.
- Replace `p-queue` with BullMQ when you need a separate worker process — `queueService.enqueue` is the only call site.
- The HNSW index is single-process. For multi-instance deployments, move the index behind a dedicated service (gRPC) or replace it with a managed vector DB (Qdrant, Pinecone, Weaviate).
- The Mongo write in `indexService.addEmbedding` is fire-and-forget; promote it to await + retry if you need strict durability.
- Ship a CDN in front of `/uploads` before going live — Express static is fine for hundreds of concurrent users, not thousands.

## Performance: optional native TensorFlow backend

By default we use the **WASM** TF.js backend (`@tensorflow/tfjs-backend-wasm`)
via `@vladmandic/face-api`'s `face-api.node-wasm` build. This needs no
native compile, has no node-gyp pain, and runs at roughly **700–1000 ms per
image** for the SSD MobileNet detector + 128-d FaceNet descriptor. For an
MVP processing a few hundred event photos through a queue, this is fine.

If you want native speed (~5–10× faster, ~80–150 ms per image):

```bash
npm i @tensorflow/tfjs-node
```

`faceService.js` will detect it at startup and switch to the
`face-api.node` build automatically (you'll see `backend: tfjs-node (native)`
in the boot log). **Note**: `@tensorflow/tfjs-node` has a known
issue building from source when the project path contains spaces (clang
chokes on the unquoted path). If your project lives somewhere like
`~/Desktop/Claude Projects/marriage`, either:

- Move it to a path without spaces (e.g. `~/projects/marriage`), or
- Symlink and install from the symlink:
  ```bash
  ln -s "$PWD" /tmp/marriage && cd /tmp/marriage && npm i @tensorflow/tfjs-node
  ```

If the prebuilt for your Node version + arch is available, the source
compile is skipped entirely and the path issue doesn't apply.

## Troubleshooting

- **`Models directory not found`** — run `npm run fetch:models`.
- **`canvas` install error** — install the system libs listed in step 1 above.
- **`mongoose connection failed`** — non-fatal; the server falls back to the JSON sidecar in `data/`. Set `MONGODB_URI` in `.env` to enable persistence.
- **`@tensorflow/tfjs-node` build fails with `clang++: no such file or directory: 'Projects/...'`** — your project path contains a space. See the section above; or just skip tfjs-node entirely (it's optional).
- **No matches even though the person is in the photo** — try `threshold=0.6`. If still nothing, the face may be too small for the SSD detector; lower `minConfidence` in `faceService.js` or use a higher-resolution source photo.
- **`multer` deprecation warning** — fixed in this repo (we're on `multer@^2.0.1`). If you still see it, delete `node_modules` and `package-lock.json` and reinstall.

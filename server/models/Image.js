// One document per (image, face) pair. A single uploaded photo with N faces
// produces N documents that share the same imageId/imageUrl but each have a
// unique embeddingId pointing into the HNSW index.

const mongoose = require('mongoose');

const ImageSchema = new mongoose.Schema(
  {
    imageId: { type: String, required: true, index: true },
    imageUrl: { type: String, required: true },
    embeddingId: { type: Number, required: true, unique: true, index: true },
    faceIndex: { type: Number, default: 0 },     // which face within the image
    faceBox: {                                   // optional: useful for highlighting
      x: Number, y: Number, width: Number, height: Number,
    },
    eventId: { type: String, default: 'default-event', index: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

ImageSchema.index({ eventId: 1, createdAt: -1 });

module.exports = mongoose.model('Image', ImageSchema);

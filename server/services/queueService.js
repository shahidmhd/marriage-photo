// queueService — a single-process async work queue.
//
// We deliberately avoid BullMQ/Redis for the MVP: face-api inference is
// CPU-heavy and runs in this same process anyway, so a Redis queue would
// add ops without real throughput gains. p-queue with concurrency=1 (or 2)
// gives us:
//   * back-pressure when the watcher dumps 100 images at once
//   * predictable ordering of "new_photo" socket emissions
//   * easy upgrade path: swap the body of `enqueue` for a BullMQ producer
//     and run a separate worker without touching callers.

const PQueue = require('p-queue').default;
const log = require('../utils/logger').make('queue');

// Concurrency: face-api uses tfjs-node which is multi-threaded internally.
// Running >1 inference in parallel from JS rarely helps and can OOM on small
// machines. Keep it 1 by default; bump via env if your box can handle it.
const concurrency = parseInt(process.env.QUEUE_CONCURRENCY, 10) || 1;
const queue = new PQueue({ concurrency });

queue.on('error', (err) => log.error('Job error', { err: err.message }));

function enqueue(label, fn) {
  return queue.add(async () => {
    const t0 = Date.now();
    try {
      const result = await fn();
      log.info('Job done', { label, ms: Date.now() - t0, pending: queue.size });
      return result;
    } catch (err) {
      log.error('Job failed', { label, err: err.message });
      throw err;
    }
  });
}

function stats() {
  return { size: queue.size, pending: queue.pending, concurrency };
}

module.exports = { enqueue, stats };

// Admin page: drop a batch of event photos straight into the index without
// touching the filesystem. Mirrors what `cp file.jpg uploads/` would do.

import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

export default function Admin() {
  const filesRef = useRef(null);
  const [eventId, setEventId] = useState('default-event');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [feed, setFeed] = useState([]);

  async function refreshStats() {
    try {
      const r = await fetch('/api/stats');
      setStats(await r.json());
    } catch {
      /* server may still be booting */
    }
  }

  useEffect(() => {
    refreshStats();
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const socket = io(apiUrl, { transports: ['websocket'] });
    socket.on('new_photo', (payload) => {
      setFeed((f) => [payload, ...f].slice(0, 24));
      refreshStats();
    });
    return () => socket.close();
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    const files = filesRef.current?.files;
    if (!files || files.length === 0) {
      setError('Pick at least one photo.');
      return;
    }
    const fd = new FormData();
    for (const f of files) fd.append('photos', f);
    fd.append('eventId', eventId || 'default-event');

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/admin/upload', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setResult(json);
      refreshStats();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head><title>Admin · Wedding Face Match</title></Head>
      <div className="container">
        <div className="header">
          <div>
            <div className="title">Admin</div>
            <div className="subtitle">Bulk-ingest event photos and watch the index grow in real time.</div>
          </div>
          <nav className="nav"><Link href="/">Guest view</Link></nav>
        </div>

        <form className="panel" onSubmit={onSubmit}>
          <div className="row">
            <div style={{ flex: 1, minWidth: 220 }}>
              <label className="label">Event ID</label>
              <input className="input" value={eventId} onChange={(e) => setEventId(e.target.value)} />
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <label className="label">Photos (multi-select)</label>
            <input ref={filesRef} className="file" type="file" multiple accept="image/jpeg,image/png,image/webp" />
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" disabled={busy} type="submit">
              {busy ? <><span className="spinner" /> &nbsp;Uploading…</> : 'Ingest photos'}
            </button>
            {error && <span className="error">{error}</span>}
          </div>
        </form>

        <div className="panel">
          <strong>Index stats</strong>
          <div className="muted" style={{ marginTop: 6 }}>
            {stats ? (
              <>embeddings: {stats.indexSize} · queue: {stats.queue?.size}/{stats.queue?.pending} · mongo: {String(stats.mongoConnected)}</>
            ) : 'loading…'}
          </div>
          {result && (
            <pre style={{ marginTop: 12, background: 'var(--panel-2)', padding: 12, borderRadius: 10, overflow: 'auto', fontSize: 12 }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>

        <div className="panel">
          <strong>Live feed</strong>
          <div className="muted" style={{ marginTop: 6 }}>Photos as they get indexed by the watcher.</div>
          {feed.length === 0 ? (
            <div className="empty">No new photos yet.</div>
          ) : (
            <div className="grid">
              {feed.map((p) => (
                <a key={p.imageId} className="card" href={p.imageUrl} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.imageUrl} alt={p.imageId} />
                  <div className="meta">
                    <span className="badge">{p.faces} face{p.faces === 1 ? '' : 's'}</span>
                    <span className="badge">{p.eventId}</span>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

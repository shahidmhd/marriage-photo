// Selfie upload form. Owns its own loading/error state and calls back to the
// parent with the matches once the API responds.
//
// Two input modes are supported via tabs:
//   - file:   user picks an image from disk (original behavior)
//   - camera: user takes a selfie with their device's front camera

import { useEffect, useRef, useState } from 'react';

export default function UploadForm({ onMatches, defaultEventId = '' }) {
  const fileRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const [mode, setMode] = useState('file'); // 'file' | 'camera'
  const [eventId, setEventId] = useState(defaultEventId);
  // The API takes an L2 distance threshold; users think in match-%. We
  // expose the friendly form here and convert at submit time.
  const [minMatchPct, setMinMatchPct] = useState('80');
  const [topK, setTopK] = useState('20');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null);

  // Camera-specific state
  const [capturedFile, setCapturedFile] = useState(null);
  const [capturedUrl, setCapturedUrl] = useState(null);
  const [camError, setCamError] = useState(null);
  const [streamReady, setStreamReady] = useState(false);

  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setStreamReady(false);
  }

  async function startStream() {
    setCamError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError('Camera not supported on this device. Use file upload instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setStreamReady(true);
    } catch (err) {
      const msg = err?.name === 'NotAllowedError'
        ? 'Camera permission denied. You can use file upload instead.'
        : `Couldn't open camera: ${err?.message || err}. Use file upload instead.`;
      setCamError(msg);
    }
  }

  // Start/stop the stream when entering/leaving camera mode.
  useEffect(() => {
    if (mode === 'camera' && !capturedFile) {
      startStream();
    } else {
      stopStream();
    }
    return stopStream;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, capturedFile]);

  // Clean up object URLs to avoid leaks.
  useEffect(() => {
    return () => {
      if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    };
  }, [capturedUrl]);

  function onPick(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    setError(null);
  }

  function onCapture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !streamRef.current) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) {
      setCamError('Camera is not ready yet — try again in a moment.');
      return;
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // Mirror the captured frame so the saved file matches what the user sees
    // in the live preview. Face recognition is invariant to horizontal flips.
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setCamError("Couldn't capture frame. Try again.");
          return;
        }
        const file = new File([blob], `selfie-${Date.now()}.jpg`, { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        setCapturedFile(file);
        setCapturedUrl(url);
        setError(null);
      },
      'image/jpeg',
      0.92,
    );
  }

  function onRetake() {
    if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    setCapturedFile(null);
    setCapturedUrl(null);
  }

  function switchMode(next) {
    if (next === mode) return;
    setError(null);
    if (next === 'file') {
      onRetake();
    } else {
      // Switching to camera: clear any file-mode preview so it's not stale.
      setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
    }
    setMode(next);
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    let file;
    if (mode === 'camera') {
      file = capturedFile;
      if (!file) {
        setError('Capture a selfie first.');
        return;
      }
    } else {
      file = fileRef.current?.files?.[0];
      if (!file) {
        setError('Please choose a selfie first.');
        return;
      }
    }

    const fd = new FormData();
    fd.append('selfie', file);
    if (eventId) fd.append('eventId', eventId);
    // The field means "strictly ABOVE N%" — a match that displays as exactly
    // N% (rounded badge) should NOT pass. We bump the similarity floor by
    // 0.005 so the cutoff lines up with the displayed integer percent:
    //   user types 80  → keep similarity > 80.5% → displays as 81%+
    // Then convert to the API's L2-distance form (similarity = 1 - d/1.4).
    const pct = Math.max(0, Math.min(99, parseFloat(minMatchPct)));
    if (!Number.isNaN(pct)) {
      const sim = pct / 100 + 0.005;
      const distance = ((1 - sim) * 1.4).toFixed(4);
      fd.append('threshold', distance);
    }
    if (topK) fd.append('topK', topK);

    setBusy(true);
    try {
      const res = await fetch('/api/upload-selfie', { method: 'POST', body: fd });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      onMatches?.(json);
    } catch (err) {
      setError(err.message);
      onMatches?.({ matches: [], error: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={onSubmit}>
      <div className="tip">
        <strong>For best matches:</strong> use a <strong>close-up</strong> photo where your
        face fills most of the frame. <strong>Eyes visible</strong> — no sunglasses, no
        hats, no heavy shadow. Wide shots, full-body photos, and group photos won&apos;t
        work — the face crop becomes too small for reliable recognition. Plain JPG, well-lit,
        front-facing.
      </div>

      <div className="tabs" role="tablist" aria-label="Selfie input mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'file'}
          className={`tab ${mode === 'file' ? 'active' : ''}`}
          onClick={() => switchMode('file')}
        >
          Upload file
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'camera'}
          className={`tab ${mode === 'camera' ? 'active' : ''}`}
          onClick={() => switchMode('camera')}
        >
          Take selfie
        </button>
      </div>

      {mode === 'file' && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="selfie preview" style={{ width: 120, height: 120, borderRadius: 12, objectFit: 'cover', border: '1px solid var(--border)' }} />
          )}
          <div style={{ flex: 1, minWidth: 260 }}>
            <label className="label">Selfie</label>
            <input ref={fileRef} className="file" type="file" accept="image/jpeg,image/png,image/webp" onChange={onPick} />
          </div>
        </div>
      )}

      {mode === 'camera' && (
        <div>
          <div className="video-wrap">
            {!capturedUrl && (
              <video ref={videoRef} autoPlay playsInline muted />
            )}
            {capturedUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="captured" src={capturedUrl} alt="captured selfie" />
            )}
            <canvas ref={canvasRef} style={{ display: 'none' }} />
          </div>
          <div className="cam-actions">
            {!capturedUrl && (
              <button type="button" className="btn" onClick={onCapture} disabled={!streamReady}>
                {streamReady ? 'Capture' : 'Starting camera…'}
              </button>
            )}
            {capturedUrl && (
              <button type="button" className="btn secondary" onClick={onRetake}>
                Retake
              </button>
            )}
          </div>
          {camError && (
            <div className="cam-error">
              {camError}{' '}
              <a onClick={() => switchMode('file')}>Switch to file upload</a>
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <label className="label">Event ID (optional)</label>
          <input className="input" value={eventId} onChange={(e) => setEventId(e.target.value)} placeholder="default-event" />
        </div>
        <div style={{ width: 120 }}>
          <label className="label">Top K</label>
          <input className="input" value={topK} onChange={(e) => setTopK(e.target.value)} type="number" min="1" max="50" />
        </div>
        <div style={{ width: 160 }}>
          <label className="label">Show above %</label>
          <input
            className="input"
            value={minMatchPct}
            onChange={(e) => setMinMatchPct(e.target.value)}
            type="number"
            min="40"
            max="95"
            step="5"
          />
        </div>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? <><span className="spinner" /> &nbsp;Matching…</> : 'Find my photos'}
        </button>
        {error && <span className="error">{error}</span>}
      </div>
    </form>
  );
}

// Guest-facing page: upload a selfie, see matches.
// Subscribes to socket "new_photo" so guests see a "new photos available"
// hint without polling.

import Head from 'next/head';
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

import UploadForm from '../components/UploadForm';
import MatchGrid from '../components/MatchGrid';

export default function Home() {
  const [response, setResponse] = useState(null);
  const [newPhotoToast, setNewPhotoToast] = useState(null);

  useEffect(() => {
    // In dev, Next rewrites /api -> :4000, but socket.io must hit the server
    // directly because rewrites don't proxy WebSockets reliably.
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const socket = io(apiUrl, { transports: ['websocket'] });
    socket.on('new_photo', (payload) => {
      setNewPhotoToast(`New photo added (${payload.faces} face${payload.faces === 1 ? '' : 's'}). Re-run search to include it.`);
      // Auto-dismiss after 4s.
      setTimeout(() => setNewPhotoToast(null), 4000);
    });
    return () => socket.close();
  }, []);

  return (
    <>
      <Head>
        <title>Find your photos · Wedding Face Match</title>
      </Head>

      <div className="container fade-in">
        <div className="header">
          <div>
            <div className="title title-gradient">Find your photos</div>
            <div className="subtitle">Upload a selfie. We&apos;ll surface every photo you appear in.</div>
          </div>
        </div>

        <UploadForm onMatches={setResponse} />

        {response?.warnings?.length > 0 && (
          <div className="panel warning-banner">
            {response.warnings.map((w, i) => (
              <div key={w.code || i} style={{ marginBottom: i < response.warnings.length - 1 ? 10 : 0 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{w.title}</div>
                <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{w.message}</div>
              </div>
            ))}
          </div>
        )}

        {response && (
          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>
                {response.matches?.length || 0} match{response.matches?.length === 1 ? '' : 'es'}
              </strong>
              {response.timings && (
                <span className="muted">
                  detect {response.timings.detectMs}ms · search {response.timings.searchMs}ms
                </span>
              )}
            </div>
            <MatchGrid matches={response.matches || []} />
          </div>
        )}

        {newPhotoToast && <div className="toast">{newPhotoToast}</div>}
      </div>
    </>
  );
}

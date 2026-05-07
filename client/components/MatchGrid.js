// Pure presentational component. Renders a grid of matched photos with
// similarity badges. Color-codes the badge based on the threshold.

export default function MatchGrid({ matches }) {
  if (!matches || matches.length === 0) {
    return <div className="empty">No matches yet — upload a selfie above.</div>;
  }

  return (
    <div className="grid">
      {matches.map((m, i) => {
        const pct = Math.round((m.similarity ?? 0) * 100);
        // Anything in `matches` already passed the server-side distance filter,
        // so it's a real match. Only boost the badge for high-confidence ones;
        // never paint a match as "warn" — that misleadingly looks like an error.
        const tier = pct >= 65 ? 'good' : '';
        return (
          <a key={m.imageId} className="card" style={{ '--i': i }} href={m.imageUrl} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={m.imageUrl} alt={m.imageId} loading="lazy" />
            <div className="meta">
              <span className={`badge ${tier}`}>{pct}% match</span>
              <span className="badge">{m.matchedFaces?.length || 1} face{(m.matchedFaces?.length || 1) > 1 ? 's' : ''}</span>
            </div>
          </a>
        );
      })}
    </div>
  );
}

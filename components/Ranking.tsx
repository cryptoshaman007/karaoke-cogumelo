import { fmtScore, type Standing } from '@/lib/types';

/** Contest ranking: one row per performance, best average first. */
export default function Ranking({ rows, limit = 50, highlightFirst = false }: { rows: Standing[]; limit?: number; highlightFirst?: boolean }) {
  if (rows.length === 0) return <p className="muted">Ninguém cantou ainda neste campeonato.</p>;
  return (
    <ol className="ranking">
      {rows.slice(0, limit).map((r, i) => (
        <li key={r.queue_id} className={highlightFirst && i === 0 && r.score != null ? 'first' : ''}>
          <span className="pos">{highlightFirst && i === 0 && r.score != null ? '🏆' : i + 1}</span>
          <div className="grow">
            <strong>{r.name}</strong>
            <span className="muted small">{r.title}</span>
          </div>
          <div className="score">
            <strong>{fmtScore(r.score)}</strong>
            <span className="muted small">{r.votes === 1 ? '1 voto' : `${r.votes} votos`}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

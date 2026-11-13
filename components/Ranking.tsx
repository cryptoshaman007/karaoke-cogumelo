import { fmtScore, type Standing } from '@/lib/types';

interface Props {
  rows: Standing[];
  limit?: number;
  highlightFirst?: boolean;
  /** what the small number under the grade counts: contest votes or night-ranking reactions */
  unit?: 'votes' | 'reactions';
  empty?: string;
  /** rows to paint as "this is you" */
  mine?: (row: Standing) => boolean;
}

/** Ranking: one row per performance, best grade first. Used by the contest and by the night ranking. */
export default function Ranking({ rows, limit = 50, highlightFirst = false, unit = 'votes', empty, mine }: Props) {
  if (rows.length === 0) return <p className="muted">{empty ?? 'Ninguém cantou ainda nesse campeonato.'}</p>;
  const count = (n: number) =>
    unit === 'votes' ? (n === 1 ? '1 voto' : `${n} votos`) : n === 1 ? '1 reação' : `${n} reações`;
  return (
    <ol className="ranking">
      {rows.slice(0, limit).map((r, i) => {
        const first = highlightFirst && i === 0 && r.score != null;
        return (
          <li key={r.queue_id} className={[first ? 'first' : '', mine?.(r) ? 'mine' : ''].join(' ').trim()}>
            <span className="pos">{first ? '🏆' : i + 1}</span>
            <div className="grow">
              <strong>{r.name}</strong>
              <span className="muted small">{r.title}</span>
            </div>
            <div className="score">
              <strong>{fmtScore(r.score)}</strong>
              <span className="muted small">{count(r.votes)}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

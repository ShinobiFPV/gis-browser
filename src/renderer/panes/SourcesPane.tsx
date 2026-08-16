import { useMemo, useState } from 'react';
import type { HarvestProgress, SourceRow } from '@shared/types';
import { FEATURE_TYPE_LABELS, groupOf, type FeatureType } from '@shared/taxonomy';

interface Props {
  sources: SourceRow[];
  progress: Record<number, HarvestProgress>;
  onRefresh: () => Promise<void>;
  busy: boolean;
}

export function SourcesPane({ sources, progress, onRefresh, busy }: Props): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const [checked, setChecked] = useState<Set<number>>(new Set());

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sources;
    return sources.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.feature_type.includes(q) ||
        (s.jurisdiction ?? '').toLowerCase().includes(q),
    );
  }, [sources, filter]);

  const grouped = useMemo(() => {
    const out = new Map<string, SourceRow[]>();
    for (const s of shown) {
      const key = groupOf(s.feature_type as FeatureType);
      const list = out.get(key);
      if (list) list.push(s);
      else out.set(key, [s]);
    }
    return [...out.entries()];
  }, [shown]);

  function toggle(id: number): void {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function harvest(): Promise<void> {
    const res = await window.gis.harvestStart([...checked]);
    if (!res.ok) console.error(res.error);
    await onRefresh();
  }

  return (
    <section className="pane" tabIndex={-1}>
      <div className="pane-header">
        Sources
        <span className="hint">{shown.length}</span>
      </div>

      <div className="filter-row">
        <input
          type="text"
          placeholder="filter by name, type, province"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="pane-body">
        {grouped.map(([group, rows]) => (
          <div key={group}>
            <div className="group">
              {group} · {rows.length}
            </div>
            {rows.map((s) => {
              const p = progress[s.id];
              const bulkWarning = s.tier === 'B' ? ' · bulk download' : '';
              return (
                <div
                  key={s.id}
                  className={`src${checked.has(s.id) ? ' sel' : ''}`}
                  onClick={() => toggle(s.id)}
                  title={s.notes ?? s.endpoint}
                >
                  <input type="checkbox" checked={checked.has(s.id)} readOnly />
                  <div className="name">{s.name}</div>
                  <span className={`tier ${s.tier}`}>{s.tier}</span>
                  <div className="meta">
                    <span>{FEATURE_TYPE_LABELS[s.feature_type as FeatureType]}</span>
                    <span>{s.jurisdiction ?? '—'}</span>
                    <span>{s.verified_count != null ? `${s.verified_count.toLocaleString()} feat` : '? feat'}</span>
                    <span className={`status ${p?.phase ?? s.status}`}>
                      {p ? `${p.phase} ${p.fetched}${p.expected ? `/${p.expected}` : ''}` : s.status}
                      {bulkWarning}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {shown.length === 0 && <div className="empty">No sources match that filter.</div>}
      </div>

      <div className="pane-footer">
        <button className="primary" disabled={checked.size === 0 || busy} onClick={() => void harvest()}>
          {busy ? 'Harvesting…' : `Harvest ${checked.size || ''}`}
        </button>{' '}
        <button disabled={!busy} onClick={() => void window.gis.harvestCancel()}>
          Cancel
        </button>
      </div>
    </section>
  );
}

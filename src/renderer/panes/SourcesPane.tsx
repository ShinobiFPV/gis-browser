import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HarvestProgress, SourceRow } from '@shared/types';
import type { BulkDownload, DiscoveredRow, DiscoveryRunResult } from '@shared/ipc';
import { FEATURE_TYPE_LABELS, groupOf } from '@shared/taxonomy';

interface Props {
  sources: SourceRow[];
  progress: Record<number, HarvestProgress>;
  onRefresh: () => Promise<void>;
  busy: boolean;
}

/** Bytes as something readable at a glance, without pulling in Intl. */
function mb(bytes: number | null | undefined): string {
  if (bytes == null) return '?';
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} kB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1e6).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

export function SourcesPane({ sources, progress, onRefresh, busy }: Props): React.JSX.Element {
  const [filter, setFilter] = useState('');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [downloads, setDownloads] = useState<BulkDownload[]>([]);
  const [showDownloads, setShowDownloads] = useState(false);

  const [showDiscovery, setShowDiscovery] = useState(false);
  const [candidates, setCandidates] = useState<DiscoveredRow[]>([]);
  const [query, setQuery] = useState('');
  const [crawling, setCrawling] = useState(false);
  const [crawlResult, setCrawlResult] = useState<DiscoveryRunResult | null>(null);
  const [crawlError, setCrawlError] = useState<string | null>(null);

  const refreshCandidates = useCallback(async () => {
    setCandidates(await window.gis.discoveryList());
  }, []);

  useEffect(() => {
    void refreshCandidates();
  }, [refreshCandidates]);

  const pendingCandidates = candidates.filter((c) => c.decision === 'new').length;

  async function crawl(): Promise<void> {
    setCrawling(true);
    setCrawlError(null);
    try {
      setCrawlResult(await window.gis.discoveryRun({ queries: [query] }));
      await refreshCandidates();
    } catch (err) {
      setCrawlError(err instanceof Error ? err.message : String(err));
    } finally {
      setCrawling(false);
    }
  }

  async function decide(id: number, decision: 'accepted' | 'rejected'): Promise<void> {
    const res = await window.gis.discoveryDecide(id, decision);
    // Accepting can legitimately fail -- an unclassifiable or nameless candidate cannot
    // become a source -- and the reason belongs on screen rather than in a console.
    setCrawlError(res.ok ? null : (res.error ?? 'Could not accept that candidate.'));
    await refreshCandidates();
    if (res.ok && decision === 'accepted') await onRefresh();
  }

  const refreshDownloads = useCallback(async () => {
    setDownloads(await window.gis.downloadsList());
  }, []);

  useEffect(() => {
    void refreshDownloads();
  }, [refreshDownloads, busy]);

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
      const key = groupOf(s.feature_type);
      const list = out.get(key);
      if (list) list.push(s);
      else out.set(key, [s]);
    }
    return [...out.entries()];
  }, [shown]);

  /**
   * What pressing Harvest will actually cost.
   *
   * The brief makes Tier B explicitly user-triggered because it downloads whole files, and
   * that is only meaningful if the size is on the button before it is pressed. An archive
   * already on disk is reused, so it is subtracted from the total rather than counted again.
   */
  const pending = useMemo(() => {
    const cached = new Set(downloads.filter((d) => d.present).map((d) => d.sourceId));
    let bytes = 0;
    let count = 0;
    let unknown = 0;
    for (const s of sources) {
      if (!checked.has(s.id) || s.tier !== 'B' || cached.has(s.id)) continue;
      count++;
      if (s.archive_bytes == null) unknown++;
      else bytes += s.archive_bytes;
    }
    return { bytes, count, unknown };
  }, [sources, checked, downloads]);

  const cachedBytes = downloads.filter((d) => d.present).reduce((n, d) => n + (d.bytes ?? 0), 0);

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

  async function removeDownload(sourceId: number): Promise<void> {
    await window.gis.downloadsRemove(sourceId);
    await refreshDownloads();
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
              const cached = downloads.find((d) => d.sourceId === s.id && d.present);
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
                    <span>{FEATURE_TYPE_LABELS[s.feature_type]}</span>
                    <span>{s.jurisdiction ?? '—'}</span>
                    <span>{s.verified_count != null ? `${s.verified_count} feat` : '? feat'}</span>
                    <span className={`status ${p?.phase ?? s.status}`}>
                      {p
                        ? p.phase === 'downloading' || p.phase === 'extracting'
                          ? `${p.phase} ${p.message}`
                          : `${p.phase} ${p.fetched}${p.expected ? `/${p.expected}` : ''}`
                        : s.status}
                    </span>
                    {s.tier === 'B' && (
                      <span className={cached ? 'bulk cached' : 'bulk'}>
                        {cached ? `${mb(cached.bytes)} on disk` : `downloads ${mb(s.archive_bytes)}`}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {shown.length === 0 && <div className="empty">No sources match that filter.</div>}
      </div>

      {/* Discovery. Collapsed until asked for: crawling is a deliberate act, not a
          background one, and the results need reading rather than glancing at. */}
      <div className="downloads">
        <button className="downloads-toggle" onClick={() => setShowDiscovery((v) => !v)}>
          {showDiscovery ? '▾' : '▸'} Discover new sources
          {pendingCandidates > 0 && ` · ${pendingCandidates} awaiting review`}
        </button>

        {showDiscovery && (
          <div className="discovery">
            <div className="discovery-run">
              <input
                type="text"
                placeholder="what to look for, e.g. Manitoba electoral divisions"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void crawl();
                }}
              />
              <button disabled={crawling || !query.trim()} onClick={() => void crawl()}>
                {crawling ? 'Crawling…' : 'Crawl'}
              </button>
            </div>

            <div className="download-note">
              Searches ArcGIS Hub and the federal, BC and Québec CKAN portals, keeps what looks
              Canadian, then checks each endpoint is live. Nothing is added to the catalog until
              you accept it.
            </div>

            {crawlResult && (
              <div className="download-note">
                {crawlResult.seen} results seen · {crawlResult.kept} candidates ·{' '}
                {crawlResult.duplicates} already known · {crawlResult.reachable} of{' '}
                {crawlResult.validated} endpoints live
              </div>
            )}
            {crawlError && <div className="warn-line error">{crawlError}</div>}

            {candidates
              .filter((c) => c.decision === 'new')
              .slice(0, 25)
              .map((c) => (
                <div key={c.id} className="candidate">
                  <div className="candidate-head">
                    <span className={`conf ${c.confidence >= 0.8 ? 'good' : c.confidence >= 0.5 ? 'mid' : 'poor'}`}>
                      {c.confidence.toFixed(2)}
                    </span>
                    <span className="candidate-title" title={`${c.endpoint}/${c.layerId}`}>
                      {c.title}
                    </span>
                    <button className="link-button" onClick={() => void decide(c.id, 'accepted')}>
                      accept
                    </button>
                    <button className="link-button" onClick={() => void decide(c.id, 'rejected')}>
                      reject
                    </button>
                  </div>
                  <div className="candidate-meta">
                    {c.featureType ?? 'unknown type'} · {c.jurisdiction ?? 'unknown where'} ·{' '}
                    {c.liveCount ?? '?'} features · {c.nameFields.join(', ') || 'no name field'} ·{' '}
                    {c.publisher ?? 'unknown publisher'}
                  </div>
                  {/* Concerns are the point of this list, so they are never collapsed. */}
                  {c.concerns.map((concern, i) => (
                    <div key={i} className="candidate-concern">
                      {concern}
                    </div>
                  ))}
                </div>
              ))}

            {candidates.length > 0 && candidates.every((c) => c.decision !== 'new') && (
              <div className="download-note">Every candidate has been ruled on.</div>
            )}
          </div>
        )}
      </div>

      {/* Download manager. Collapsed by default: it only matters once something is cached. */}
      {downloads.length > 0 && (
        <div className="downloads">
          <button className="downloads-toggle" onClick={() => setShowDownloads((v) => !v)}>
            {showDownloads ? '▾' : '▸'} {downloads.filter((d) => d.present).length} archive
            {downloads.filter((d) => d.present).length === 1 ? '' : 's'} cached · {mb(cachedBytes)}
          </button>
          {showDownloads &&
            downloads.map((d) => (
              <div key={d.sourceId} className="download-row">
                <div className="name">{d.sourceName}</div>
                <span className="mono">{d.present ? mb(d.bytes) : 'file deleted'}</span>
                <span className="mono dim" title={`sha256 ${d.sha256 ?? '?'}`}>
                  {d.sha256 ? d.sha256.slice(0, 8) : '—'}
                </span>
                <button className="link-button" onClick={() => void removeDownload(d.sourceId)}>
                  {d.present ? 'delete' : 'forget'}
                </button>
              </div>
            ))}
          {showDownloads && (
            <div className="download-note">
              Deleting an archive frees disk. The boundaries it indexed stay in the catalog with
              their geometry — nothing needs re-downloading unless you re-harvest that source.
            </div>
          )}
        </div>
      )}

      <div className="pane-footer">
        {pending.count > 0 && (
          <div className="download-warning">
            {pending.count} bulk source{pending.count === 1 ? '' : 's'} will download{' '}
            <b>{mb(pending.bytes)}</b>
            {pending.unknown > 0 && ` plus ${pending.unknown} of unknown size`}, kept on disk and
            reused.
          </div>
        )}
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

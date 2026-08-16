import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, Candidate, HarvestProgress, SourceRow } from '@shared/types';
import type { LogLine } from '@shared/ipc';
import { SourcesPane } from './panes/SourcesPane';
import { SearchPane } from './panes/SearchPane';
import { PreviewPane } from './panes/PreviewPane';
import { ExportPane } from './panes/ExportPane';

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [progress, setProgress] = useState<Record<number, HarvestProgress>>({});
  const [lastLog, setLastLog] = useState<LogLine | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);

  const promptRef = useRef<HTMLTextAreaElement>(null);

  const refreshSources = useCallback(async () => {
    setSources(await window.gis.sourcesList());
  }, []);

  useEffect(() => {
    void window.gis.settingsGet().then(setSettings);
    void refreshSources();

    const offProgress = window.gis.onHarvestProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.sourceId]: p }));
      if (p.phase === 'done' || p.phase === 'failed') void refreshSources();
    });
    const offLog = window.gis.onLog(setLastLog);

    return () => {
      offProgress();
      offLog();
    };
  }, [refreshSources]);

  // Keyboard-driven: "/" jumps to the prompt from anywhere outside a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if (e.key === '/' && !typing) {
        e.preventDefault();
        promptRef.current?.focus();
      }
      if (e.key === 'Escape' && typing) (e.target as HTMLElement).blur();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const harvesting = Object.values(progress).some((p) => p.phase !== 'done' && p.phase !== 'failed');

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          GIS <span>Browser</span>
        </div>
        <div className="stat">
          <b>{sources.length}</b> sources seeded
        </div>
        <div className="stat">
          <b>{sources.filter((s) => s.tier === 'A').length}</b> tier A
          {' / '}
          <b>{sources.filter((s) => s.tier === 'B').length}</b> tier B
        </div>
        <div className="spacer" />
        <div className="stat">
          Claude key: <b>{settings?.hasAnthropicKey ? 'stored' : 'not set'}</b>
        </div>
      </header>

      <div className="panes">
        <SourcesPane sources={sources} progress={progress} onRefresh={refreshSources} busy={harvesting} />
        <SearchPane promptRef={promptRef} onSelect={setSelected} hasKey={settings?.hasAnthropicKey ?? false} />
        <PreviewPane candidate={selected} />
        <ExportPane candidate={selected} />
      </div>

      <footer className="statusbar">
        <span className="mono">{settings?.dbPath ?? 'opening database…'}</span>
        <span className="spacer" />
        {lastLog && (
          <span className={`msg ${lastLog.level === 'error' ? 'error' : lastLog.level === 'warn' ? 'warn' : ''}`}>
            [{lastLog.scope}] {lastLog.message}
          </span>
        )}
        <span>
          <kbd>/</kbd> search
        </span>
      </footer>
    </div>
  );
}

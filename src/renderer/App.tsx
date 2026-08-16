import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, Candidate, HarvestProgress, SourceRow } from '@shared/types';
import type { GeometryResult, LogLine } from '@shared/ipc';
import { SourcesPane } from './panes/SourcesPane';
import { SearchPane } from './panes/SearchPane';
import { PreviewPane } from './panes/PreviewPane';
import { ExportPane } from './panes/ExportPane';
import { SettingsStrip } from './components/SettingsStrip';

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [progress, setProgress] = useState<Record<number, HarvestProgress>>({});
  const [lastLog, setLastLog] = useState<LogLine | null>(null);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [geometry, setGeometry] = useState<GeometryResult | null>(null);
  const [showSettings, setShowSettings] = useState(
    new URLSearchParams(location.search).has('settings'),
  );

  const promptRef = useRef<HTMLTextAreaElement>(null);

  const refreshSources = useCallback(async () => {
    setSources(await window.gis.sourcesList());
  }, []);

  const refreshSettings = useCallback(async () => {
    setSettings(await window.gis.settingsGet());
  }, []);

  useEffect(() => {
    void refreshSettings();
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
  }, [refreshSources, refreshSettings]);

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

  /**
   * Dev harness. `?demo=<query>` runs a search and selects the top hit on start, so the
   * whole search -> fetch -> render path can be driven without a human clicking, and
   * `?settings` opens the settings strip. Query strings only reach the renderer via
   * ELECTRON_RENDERER_URL in development; a packaged build uses loadFile and can never
   * trigger either.
   */
  const demoQuery = new URLSearchParams(location.search).get('demo');

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
        <button
          className="titlebar-button"
          onClick={() => setShowSettings((v) => !v)}
          title="API key and model"
        >
          Claude: <b>{settings?.hasAnthropicKey ? (settings.models.find((m) => m.id === settings.anthropicModel)?.label ?? 'key stored') : 'no key'}</b>
        </button>
      </header>

      {showSettings && settings && (
        <SettingsStrip
          settings={settings}
          onChanged={refreshSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      <div className="panes">
        <SourcesPane sources={sources} progress={progress} onRefresh={refreshSources} busy={harvesting} />
        <SearchPane
          promptRef={promptRef}
          selected={selected}
          onSelect={setSelected}
          hasKey={settings?.hasAnthropicKey ?? false}
          demoQuery={demoQuery}
        />
        <PreviewPane candidate={selected} onGeometry={setGeometry} />
        <ExportPane candidate={selected} geometry={geometry} />
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

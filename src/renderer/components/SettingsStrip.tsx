import { useEffect, useState } from 'react';
import type { AppSettings } from '@shared/types';
import type { UpdateStatus } from '@shared/ipc';
import { LLM_PROVIDERS, modelInfo, providerInfo } from '@shared/llm-providers';

interface Props {
  settings: AppSettings;
  onChanged: () => Promise<void>;
  onClose: () => void;
}

/** Sentinel for the "type the model id yourself" option in the model dropdown. */
const CUSTOM = '__custom__';

/**
 * Settings as an inline strip rather than a dialog.
 *
 * The brief bans modal dialogs in the search-to-export path. Settings is not strictly in
 * that path, but a newsroom tool that steals focus is a newsroom tool that gets in the
 * way, so this slides in under the titlebar and can be dismissed with Escape.
 */
export function SettingsStrip({ settings, onChanged, onClose }: Props): React.JSX.Element {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  // Read, never triggered: opening Settings should not itself cause a network call.
  useEffect(() => {
    void window.gis.updateStatus().then(setUpdate);
  }, []);

  const provider = providerInfo(settings.llmProvider);
  const model = modelInfo(provider.id, settings.llmModel);
  const hasKey = settings.providersWithKeys.includes(provider.id);
  const listed = provider.models.some((m) => m.id === settings.llmModel);
  // A provider with no built-in list is always in custom mode; so is a hand-typed id.
  const [customModel, setCustomModel] = useState(!listed);

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await fn();
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  const saveKey = (): Promise<void> =>
    run(async () => {
      if (!key.trim()) return;
      const res = await window.gis.keySet(provider.id, key);
      // Cleared immediately either way — the key should not sit in renderer state any
      // longer than the moment it takes to hand it to main.
      setKey('');
      setMessage(res.ok ? `Key stored for ${provider.label}, encrypted by the OS.` : (res.error ?? 'Could not store the key.'));
    });

  const clearKey = (): Promise<void> =>
    run(async () => {
      await window.gis.keyClear(provider.id);
      setMessage(`Key removed for ${provider.label}.`);
    });

  const chooseProvider = (id: string): Promise<void> =>
    run(async () => {
      const res = await window.gis.llmConfigSet({ providerId: id });
      setMessage(res.ok ? null : (res.error ?? 'Could not change provider.'));
      setCustomModel(providerInfo(id).models.length === 0);
    });

  const chooseModel = (value: string): Promise<void> =>
    run(async () => {
      if (value === CUSTOM) {
        setCustomModel(true);
        return;
      }
      setCustomModel(false);
      const res = await window.gis.llmConfigSet({ model: value });
      setMessage(res.ok ? null : (res.error ?? 'Could not change model.'));
    });

  const commit = (patch: { model?: string; baseUrl?: string }): Promise<void> =>
    run(async () => {
      const res = await window.gis.llmConfigSet(patch);
      setMessage(res.ok ? null : (res.error ?? 'Could not save that.'));
    });

  return (
    <div className="settings-strip" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="settings-row">
        <label className="field settings-provider">
          <span>Provider</span>
          <select value={provider.id} disabled={busy} onChange={(e) => void chooseProvider(e.target.value)}>
            {LLM_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {settings.providersWithKeys.includes(p.id) ? ' ✓' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="field settings-model">
          <span>Model</span>
          {customModel || provider.models.length === 0 ? (
            <input
              type="text"
              placeholder="model id, e.g. llama3.1:8b"
              defaultValue={settings.llmModel}
              disabled={busy}
              onBlur={(e) => void commit({ model: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          ) : (
            <select value={settings.llmModel} disabled={busy} onChange={(e) => void chooseModel(e.target.value)}>
              {provider.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.id}
                </option>
              ))}
              <option value={CUSTOM}>Something else…</option>
            </select>
          )}
        </label>

        <span className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>

      <div className="settings-row">
        <label className="field settings-key">
          <span>
            {provider.label} API key
            {!provider.keyRequired && <span className="dim"> — optional for this one</span>}
          </span>
          <input
            type="password"
            autoFocus
            placeholder={hasKey ? '•••••••• stored' : provider.keyHint}
            value={key}
            disabled={busy}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey();
            }}
          />
        </label>

        <button className="primary" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
          Save
        </button>
        <button disabled={busy || !hasKey} onClick={() => void clearKey()}>
          Clear
        </button>

        {/* Only where pointing it somewhere else is the entire purpose. */}
        {provider.baseUrlEditable && (
          <label className="field settings-baseurl">
            <span>Base URL</span>
            <input
              type="text"
              placeholder={provider.defaultBaseUrl}
              defaultValue={settings.llmBaseUrl}
              disabled={busy}
              onBlur={(e) => void commit({ baseUrl: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
          </label>
        )}
      </div>

      <div className="settings-note">
        {provider.note}
        {provider.keyUrl && (
          <>
            {' '}
            <a href={provider.keyUrl} target="_blank" rel="noreferrer">
              Get a key
            </a>
            .
          </>
        )}
      </div>

      <div className="settings-note">
        {model.note}
        {!model.structuredOutputs && (
          <span className="warn">
            {' '}
            This model cannot be schema-constrained, so a malformed reply falls back to the local parser.
          </span>
        )}
      </div>

      {/* Update checking is the one thing the app does on the network unprompted, so it
          says so plainly and can be switched off. */}
      <div className="settings-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={update?.enabled ?? true}
            disabled={busy}
            onChange={(e) => void window.gis.updateSetEnabled(e.target.checked).then(setUpdate)}
          />
          Check for updates automatically
        </label>

        <button
          disabled={busy || checking}
          onClick={() => {
            setChecking(true);
            void window.gis
              .updateCheck()
              .then(setUpdate)
              .finally(() => setChecking(false));
          }}
        >
          {checking ? 'Checking…' : 'Check now'}
        </button>

        <span className="dim">
          {update?.error
            ? `Last check failed: ${update.error}`
            : update?.latestVersion
              ? update.updateAvailable
                ? `Version ${update.latestVersion} is available.`
                : `Up to date — running ${update.currentVersion}.`
              : `Running ${update?.currentVersion ?? '…'}.`}
        </span>
      </div>

      <div className="settings-note">
        When enabled, the app asks GitHub for the latest release — at most once every six hours, and
        never more than that. It sends nothing about you and nothing about your catalog. Updates are
        never downloaded or installed automatically: the builds are unsigned, so installing stays a
        deliberate act.
      </div>

      <div className="settings-note">
        Keys are encrypted by the OS and stored outside the catalog database, one per provider, so switching
        back does not mean re-entering anything. A key is never sent to the renderer, never written to the
        catalog, and never logged. All model calls are made from the main process, and{' '}
        <b>boundary geometry is never sent to any of them</b> — only names, types and sources.{' '}
        {message && <b>{message}</b>}
      </div>
    </div>
  );
}

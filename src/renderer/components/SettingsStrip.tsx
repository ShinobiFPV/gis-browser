import { useState } from 'react';
import type { AppSettings } from '@shared/types';

interface Props {
  settings: AppSettings;
  onChanged: () => Promise<void>;
  onClose: () => void;
}

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

  const model = settings.models.find((m) => m.id === settings.anthropicModel);

  async function saveKey(): Promise<void> {
    if (!key.trim()) return;
    setBusy(true);
    const res = await window.gis.keySet(key);
    // Clear the field immediately either way — the key should not sit in renderer state
    // any longer than the moment it takes to hand it to main.
    setKey('');
    setMessage(res.ok ? 'Key stored, encrypted by Windows.' : (res.error ?? 'Could not store the key.'));
    await onChanged();
    setBusy(false);
  }

  async function clearKey(): Promise<void> {
    setBusy(true);
    await window.gis.keyClear();
    setMessage('Key removed.');
    await onChanged();
    setBusy(false);
  }

  async function chooseModel(id: string): Promise<void> {
    setBusy(true);
    const res = await window.gis.modelSet(id);
    if (!res.ok) setMessage(res.error ?? 'Could not change the model.');
    await onChanged();
    setBusy(false);
  }

  return (
    <div className="settings-strip" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="settings-row">
        <label className="field settings-key">
          <span>Anthropic API key</span>
          <input
            type="password"
            autoFocus
            placeholder={settings.hasAnthropicKey ? '•••••••• stored' : 'sk-ant-…'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey();
            }}
          />
        </label>

        <button className="primary" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
          Save
        </button>
        <button disabled={busy || !settings.hasAnthropicKey} onClick={() => void clearKey()}>
          Clear
        </button>

        <label className="field settings-model">
          <span>Model</span>
          <select value={settings.anthropicModel} disabled={busy} onChange={(e) => void chooseModel(e.target.value)}>
            {settings.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.id}
              </option>
            ))}
          </select>
        </label>

        <span className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>

      <div className="settings-note">
        {model?.note}
        {model && !model.structuredOutputs && (
          <span className="warn">
            {' '}
            This model cannot be schema-constrained, so a malformed reply falls back to the local parser.
          </span>
        )}
      </div>

      <div className="settings-note">
        The key is encrypted with Windows DPAPI and stored outside the catalog database. It is never sent to
        the renderer, never written to the catalog, and never logged. All Claude calls are made from the main
        process. {message && <b>{message}</b>}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { Modal, Button } from '../components/ui';
import type { ModelSettings } from '../protocol/types';
import type { ControllerClient } from '../protocol/client';
import { DEFAULT_SETTINGS } from '../model/settings';

export function Settings({
  open,
  onOpenChange,
  client,
  saved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: ControllerClient;
  saved: (settings: ModelSettings) => void;
}) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (open) {
      setError('');
      setChecked(false);
      client
        .call<ModelSettings>('settings.get')
        .then(setSettings)
        .catch((error) => setError(error.message));
    }
  }, [open]);
  function change<K extends keyof ModelSettings>(key: K, value: ModelSettings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
    setChecked(false);
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      await client.call('settings.save', settings);
      saved(settings);
      onOpenChange(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function check() {
    setBusy(true);
    setError('');
    setChecked(false);
    try {
      await client.call('settings.check', settings);
      setChecked(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Model and preferences"
      description="Configure a Chat Completions compatible endpoint. Requests are sent directly by the extension."
      sheet
    >
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Service type
          <select
            value={settings.provider}
            onChange={(event) =>
              change('provider', event.target.value as ModelSettings['provider'])
            }
          >
            <option value="openai-compatible">OpenAI compatible</option>
          </select>
        </label>
        <label>
          API Base URL
          <input
            value={settings.baseURL}
            onChange={(event) => change('baseURL', event.target.value)}
            placeholder="https://your-provider.example/v1"
            required
            type="url"
          />
        </label>
        <label>
          Model name
          <input
            value={settings.model}
            onChange={(event) => change('model', event.target.value)}
            placeholder="Enter the model ID from your provider"
            required
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            autoComplete="off"
            value={settings.apiKey}
            onChange={(event) => change('apiKey', event.target.value)}
            placeholder="Stored locally in this extension"
          />
        </label>
        <label>
          Auto-compact threshold (tokens)
          <input
            type="number"
            min="0"
            step="1"
            required
            value={settings.autoCompactTokenLimit ?? ''}
            onChange={(event) =>
              change(
                'autoCompactTokenLimit',
                event.target.value === '' ? undefined : event.target.valueAsNumber,
              )
            }
          />
          <span className="muted small">
            Estimated total input budget. Default 64000; 0 disables. Set below your model's context
            limit to leave room for replies and summarization.
          </span>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.supportsImages}
            onChange={(event) => change('supportsImages', event.target.checked)}
          />
          Model supports images and page screenshots
        </label>
        <label>
          Theme
          <select
            value={settings.theme}
            onChange={(event) => change('theme', event.target.value as ModelSettings['theme'])}
          >
            <option value="system">Use DevTools theme</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <p className="muted small">
          Your key is kept out of workspace files, prompts, and Monkey settings exports. Checking
          the connection sends a short request to this endpoint.
        </p>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {checked && (
          <div className="success-text">
            <Check size={14} />
            Connection successful
          </div>
        )}
        <div className="form-actions">
          <Button onClick={() => void check()} disabled={busy}>
            {busy && <LoaderCircle size={14} className="spin" />}Check connection
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Save settings
          </Button>
        </div>
      </form>
    </Modal>
  );
}

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
      title="模型与偏好"
      description="配置兼容 Chat Completions 的模型服务，调用由扩展直接发起。"
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
          服务类型
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
          模型名称
          <input
            value={settings.model}
            onChange={(event) => change('model', event.target.value)}
            placeholder="填写服务商提供的模型 ID"
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
            placeholder="保存在此扩展的本地配置中"
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.supportsImages}
            onChange={(event) => change('supportsImages', event.target.checked)}
          />
          模型支持图片，可查看页面截图
        </label>
        <label>
          界面主题
          <select
            value={settings.theme}
            onChange={(event) => change('theme', event.target.value as ModelSettings['theme'])}
          >
            <option value="system">跟随开发者工具</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <p className="muted small">
          密钥不进入 Agent 工作区、提示词或 Monkey 设置导出。连接检查会向当前服务发送一条简短请求。
        </p>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {checked && (
          <div className="success-text">
            <Check size={14} />
            连接成功
          </div>
        )}
        <div className="form-actions">
          <Button onClick={() => void check()} disabled={busy}>
            {busy && <LoaderCircle size={14} className="spin" />}检查连接
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            保存设置
          </Button>
        </div>
      </form>
    </Modal>
  );
}

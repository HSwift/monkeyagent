import { createRoot } from 'react-dom/client';
import { ControllerClient } from '../protocol/client';
import { App } from './app';
import './style.css';

const client = new ControllerClient();
if (import.meta.env.DEV && !globalThis.chrome?.runtime?.id) {
  void import('../fixtures/preview').then((module) => module.startPreview(client));
}
window.addEventListener('message', (event) => {
  if (
    event.origin !== location.origin ||
    event.data?.type !== 'monkeyagent:connect' ||
    !event.ports[0]
  )
    return;
  client.connect(event.ports[0]);
});
createRoot(document.getElementById('root')!).render(<App client={client} />);

import { useState } from 'react';
import { CheckCircle2, Download, ShieldCheck } from 'lucide-react';
import { api } from './api';
import type { LocalAIStatus, LocalModelPreference } from '../shared/types';

export function LocalAISetup({ state }: { state?: LocalAIStatus }) {
  const [error, setError] = useState(''), [requesting, setRequesting] = useState(false);
  const working = requesting || ['checking','downloading','loading'].includes(state?.status || '');
  const ready = state?.status === 'ready', installed = state?.status === 'installed';
  const apple = state?.apple, usingApple = state?.provider === 'apple';
  const unavailableApple = apple && !apple.available && state?.preference !== 'qwen';
  const canEnable = apple?.reason === 'disabled' || apple?.reason === 'notReady';
  async function action(task: () => Promise<unknown>) {
    setError(''); setRequesting(true);
    try { await task(); } catch(e) { setError(e instanceof Error ? e.message : 'Could not prepare local AI.'); }
    finally { setRequesting(false); }
  }
  const setup = () => action(() => api(installed ? '/local/warm' : '/local/setup', { method: 'POST' }));
  const select = (preference: LocalModelPreference) => action(() => api('/local/model', { method: 'POST', body: JSON.stringify({preference}) }));
  const useQwen = () => action(async () => { await api('/local/model', { method: 'POST', body: JSON.stringify({preference:'qwen'}) }); await api('/local/setup', {method:'POST'}); });
  return <section className="local-ai-setup">
    <div className="local-ai-heading"><span className="feature-icon yellow"><ShieldCheck size={22}/></span><div><h3>Local AI</h3><p>{usingApple ? 'Apple AI' : 'Qwen3 4B'} · on this Mac</p></div><span className={`ai-state ${ready ? 'ready' : ''}`} role="status">{ready ? <CheckCircle2 size={16}/> : working ? <span className="spinner"/> : null}{ready ? 'Ready' : working ? 'Preparing' : installed ? 'Installed' : 'Set up'}</span></div>
    {unavailableApple && <>
      <p className="input-hint">{apple.reason === 'disabled' ? 'Apple Intelligence is off.' : apple.reason === 'notReady' ? 'Apple AI is still downloading.' : apple.reason === 'unsupported' ? 'Apple AI needs a compatible Mac and macOS 26+.' : 'Apple AI is unavailable.'}</p>
      <div className="local-ai-actions">
        {canEnable && (window.quickenDesktop?.openAppleSettings ? <button type="button" className="secondary" disabled={working} onClick={() => window.quickenDesktop?.openAppleSettings?.()}>Open Settings</button> : <span className="input-hint">Enable it in System Settings → Apple Intelligence.</span>)}
        <button type="button" className="text-button" disabled={working} onClick={() => void action(() => api('/local/refresh', {method:'POST'}))}>Check again</button>
      </div>
    </>}
    {(state?.status === 'error' || state?.status === 'unavailable' || working) && state?.detail && <p className={state.status === 'error' || state.status === 'unavailable' ? 'error-text' : 'input-hint'}>{state.detail}</p>}
    {state?.progress !== undefined && <progress aria-label="Local model download" value={state.progress} max={1}/>}
    {!ready && <button type="button" className="secondary" disabled={working || !state || state.status === 'unavailable'} onClick={() => void (unavailableApple ? useQwen() : setup())}><Download size={15}/>{working ? 'Preparing…' : installed ? 'Load models' : usingApple && !unavailableApple ? 'Download speech · 224 MB' : state?.qwenInstalled ? 'Use Qwen' : 'Download Qwen · 2.7 GB'}</button>}
    <details className="compact-details"><summary>Model</summary>
      <p>Offline · English · no API keys</p>
      {state?.provider && <div className="local-ai-actions">
        <button type="button" className="secondary" disabled={working || state.preference !== 'qwen'} onClick={() => void select('auto')}>Use Apple AI</button>
        <button type="button" className="secondary" disabled={working || state.preference === 'qwen'} onClick={() => void useQwen()}>{state.qwenInstalled ? 'Use Qwen' : 'Download Qwen · 2.7 GB'}</button>
      </div>}
    </details>
    {error && <p role="alert" className="error-text">{error}</p>}
  </section>;
}

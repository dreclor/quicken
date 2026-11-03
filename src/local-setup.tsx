import { useState } from 'react';
import { CheckCircle2, Download, ShieldCheck } from 'lucide-react';
import { api } from './api';
import type { LocalAIStatus } from '../shared/types';

export function LocalAISetup({ state }: { state?: LocalAIStatus }) {
  const [error, setError] = useState(''), [requesting, setRequesting] = useState(false);
  const working = requesting || state?.status === 'downloading' || state?.status === 'loading';
  const ready = state?.status === 'ready', installed = state?.status === 'installed';
  const problem = state?.status === 'error' || state?.status === 'unavailable';
  async function setup() {
    setError(''); setRequesting(true);
    try { await api(installed ? '/local/warm' : '/local/setup', { method: 'POST' }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not prepare local AI.'); }
    finally { setRequesting(false); }
  }
  return <section className="local-ai-setup">
    <div className="local-ai-heading"><span className="feature-icon yellow"><ShieldCheck size={22}/></span><div><h3>Local AI</h3><p>Offline · English · no API keys</p></div><span className={`ai-state ${ready ? 'ready' : ''}`} role="status">{ready ? <CheckCircle2 size={16}/> : working ? <span className="spinner"/> : null}{ready ? 'Ready' : working ? 'Preparing' : installed ? 'Installed' : problem ? 'Needs attention' : 'Not installed'}</span></div>
    {(problem || working) && state?.detail && <p className={problem ? 'error-text' : 'input-hint'}>{state.detail}</p>}
    {state?.progress !== undefined && <progress aria-label="Local model download" value={state.progress} max={1}/>}
    {!ready && <button type="button" className="secondary" disabled={working || !state || state.status === 'unavailable'} onClick={() => void setup()}><Download size={15}/>{working ? 'Preparing…' : installed ? 'Load models' : 'Download · 3 GB'}</button>}
    <details className="compact-details"><summary>Details</summary><p>{state?.model || 'Qwen3 4B'}. Transcription, responses, voice, and notes run on this Mac after the one-time download.</p></details>
    {error && <p role="alert" className="error-text">{error}</p>}
  </section>;
}

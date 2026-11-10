import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OfflineEngine, languageModel } from '../server/local/engine';
import type { AppleAvailability } from '../shared/types';

const roots: string[] = [], engines: OfflineEngine[] = [];
function fixture(reason: AppleAvailability['reason']) {
  const root = mkdtempSync(join(tmpdir(), 'quicken-selection-')); roots.push(root);
  const nativeDir = join(root, 'native'); mkdirSync(nativeDir); mkdirSync(join(nativeDir,'licenses'));
  for (const name of ['quicken-speech','quicken-llm','quicken-voice']) writeFileSync(join(nativeDir,name),'');
  let availability: AppleAvailability = { available: reason === 'available', reason };
  const apple = { availability: vi.fn(async () => availability), complete: vi.fn(async () => 'Apple reply'), close: vi.fn() };
  const engine = new OfflineEngine(() => {}, { directory: root, nativeDir, appleClient: apple }); engines.push(engine);
  return { engine, root, apple, setApple: (value: AppleAvailability) => { availability = value; } };
}
afterEach(() => { for(const engine of engines.splice(0))engine.close(); for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true}); vi.restoreAllMocks(); });
describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('local model selection', () => {
  it('prefers Apple without Qwen weights, and setup installs only speech', async () => {
    const {engine,root,apple}=fixture('available'); await engine.refresh();
    expect(engine.status).toMatchObject({provider:'apple',status:'missing',qwenInstalled:false});
    const speech=vi.spyOn(engine as any,'callSpeech').mockResolvedValue({});
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Unexpected network'));
    await engine.setup();
    expect(engine.status).toMatchObject({provider:'apple',status:'ready',speechInstalled:true});
    expect(existsSync(join(root,languageModel.file))).toBe(false);expect(network).not.toHaveBeenCalled();
    expect(speech).toHaveBeenCalledWith('install',expect.anything(),expect.anything());
    expect(await engine.complete('Question','Context')).toBe('Apple reply');expect(apple.complete).toHaveBeenCalled();
  });
  it.each(['disabled','unsupported','notReady','helperMissing'] as const)('reports %s and requires setup without downloading Qwen', async reason => {
    const {engine,root}=fixture(reason);await engine.refresh();
    expect(engine.status).toMatchObject({provider:'qwen',status:'missing',apple:{available:false,reason}});
    expect(existsSync(join(root,languageModel.file))).toBe(false);
  });
  it('detects Apple after the user enables it',async()=>{
    const {engine,setApple}=fixture('disabled');await engine.refresh();setApple({available:true,reason:'available'});await engine.refresh();
    expect(engine.status.provider).toBe('apple');
  });
  it('persists the explicit Qwen choice and can switch back to Apple',async()=>{
    const {engine,root}=fixture('available');await engine.refresh();await engine.selectModel('qwen');
    expect(engine.status).toMatchObject({provider:'qwen',preference:'qwen'});
    expect(JSON.parse(readFileSync(join(root,'model-preference.json'),'utf8')).preference).toBe('qwen');
    await engine.refresh();expect(engine.status.provider).toBe('qwen');
    await engine.selectModel('auto');expect(engine.status.provider).toBe('apple');
  });
  it('surfaces lost Apple availability after a ready model fails',async()=>{
    const {engine,apple,setApple}=fixture('available');await engine.refresh();
    vi.spyOn(engine as any,'callSpeech').mockResolvedValue({});await engine.setup();
    setApple({available:false,reason:'disabled'});apple.complete.mockRejectedValueOnce(new Error('Model unavailable'));
    await expect(engine.complete('Question','Context')).rejects.toThrow();
    expect(engine.status).toMatchObject({status:'error',provider:'apple',apple:{available:false,reason:'disabled'}});
  });
  it('rejects Apple becoming unavailable instead of loading Qwen or going to cloud',async()=>{
    const {engine,root,setApple}=fixture('available');writeFileSync(join(root,'speech-ready.json'),'{}');await engine.refresh();
    setApple({available:false,reason:'disabled'});
    await expect(engine.prepare()).rejects.toThrow('Apple AI is unavailable');expect(engine.status.status).toBe('error');
  });
});

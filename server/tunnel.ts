import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export class TestTunnel {
  private child?: ChildProcess;
  private pending?: Promise<string>;
  url = '';
  start(port: number): Promise<string> {
    if (this.url && this.child && this.child.exitCode === null) return Promise.resolve(this.url);
    if (this.pending) return this.pending;
    const binary = [process.env.QUICKEN_CLOUDFLARED, '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'].find(p => p && existsSync(p));
    if (!binary) return Promise.reject(new Error('Install cloudflared with “brew install cloudflared”, or paste your own public HTTPS bridge URL.'));
    this.pending = new Promise<string>((resolve, reject) => {
      const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let finished = false, buffer = '';
      const finish = (error?: Error, url?: string) => {
        if (finished) return;
        finished = true; clearTimeout(timeout);
        if (error) { child.kill(); reject(error); }
        else { this.url = url!; resolve(url!); }
      };
      const timeout = setTimeout(() => finish(new Error('The test bridge timed out. Check your network or use a persistent HTTPS tunnel.')), 25_000);
      const output = (data: Buffer) => {
        buffer = (buffer + data.toString()).slice(-8000);
        const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) finish(undefined, match[0]);
      };
      child.stdout?.on('data', output); child.stderr?.on('data', output);
      child.once('error', () => finish(new Error('Could not start cloudflared. Check that it is installed.')));
      child.once('exit', () => {
        if (this.child === child) { this.child = undefined; this.url = ''; }
        finish(new Error('The test bridge stopped before it was ready. Please retry.'));
      });
    }).then(async url => {
      // The hostname is printed before DNS propagation and the first edge connection.
      for(let attempt=0;attempt<10;attempt++) {
        try { const r=await fetch(url+'/health',{signal:AbortSignal.timeout(3000)});if(r.ok&&(await r.json() as {app?:string}).app==='Quicken')return url; } catch { /* Retry until the new route is reachable. */ }
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      this.stop();throw new Error('The public bridge could not be reached. Check your network and retry.');
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  stop() { this.child?.kill(); this.child = undefined; this.url = ''; }
}

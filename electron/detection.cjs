const { spawn } = require('node:child_process');
const supported = [
  [/^us\.zoom\./i, 'Zoom'], [/^com\.microsoft\.teams/i, 'Microsoft Teams'],
  [/^com\.cisco\./i, 'Webex'], [/^com\.google\.Chrome/i, 'Google Chrome'],
  [/^com\.microsoft\.edgemac/i, 'Microsoft Edge'], [/^org\.mozilla\.firefox/i, 'Firefox'],
  [/^com\.apple\.Safari/i, 'Safari'],
];
function classifyApps(bundleIds) {
  return [...new Set(bundleIds.flatMap(id => {
    const match = supported.find(([pattern]) => pattern.test(id));
    return match ? [match[1]] : [];
  }))].sort();
}
class MeetingDetector {
  constructor(binary, notify) { this.binary = binary; this.notify = notify; this.state = { enabled: false, apps: [] }; }
  setEnabled(enabled) {
    this.stop(); this.state = { enabled, apps: [] }; this.notify(this.state);
    if (!enabled) return;
    const child = spawn(this.binary, [], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          this.state = { enabled: true, apps: classifyApps(data.microphoneApps || []), ...(data.error ? { error: data.error } : {}) };
          this.notify(this.state);
        } catch { /* Ignore an incomplete native event. */ }
      }
    });
    child.once('error', () => { if (this.child === child) { this.state = { enabled: true, apps: [], error: 'Meeting hints unavailable. Start a session manually.' }; this.notify(this.state); } });
    child.once('exit', () => { if (this.child === child) { this.child = undefined; this.state = { enabled: true, apps: [], error: 'Meeting hints stopped. Toggle detection to retry.' }; this.notify(this.state); } });
  }
  stop() { const child = this.child; this.child = undefined; child?.kill(); }
}
module.exports = { MeetingDetector, classifyApps };

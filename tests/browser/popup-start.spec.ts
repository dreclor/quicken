import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppState, Meeting } from '../../shared/types';

const token = readFileSync(resolve(process.env.QUICKEN_DATA_DIR || '.quicken','access-token'), 'utf8').trim();
const fixture = (): AppState => ({ meetings: [], localAI: {status:'ready',detail:'Local test engine ready',model:'Fixture',language:'English'}, settings: { hasOpenaiKey: true, hasRecallKey: false, recallRegion: 'us-west-2', publicBaseUrl: '', realtimeModel: 'fixture', notesModel: 'fixture' } });
async function openPopup(page: Page, state: AppState) {
  let socket: WebSocketRoute;
  await page.routeWebSocket('**/socket', ws => {
    socket = ws;
    ws.onMessage(() => ws.send(JSON.stringify({ type: 'state', ...state })));
  });
  await page.setViewportSize({ width: 350, height: 440 });
  await page.goto('/popup#access=' + token);
  await page.getByRole('button', { name: 'Activate Quicken' }).click();
  return () => socket.send(JSON.stringify({ type: 'state', ...state }));
}

test('popup explains missing local models and optional cloud keys without creating a meeting', async ({ page }) => {
  const state = fixture(); state.settings.hasOpenaiKey = false; state.localAI = {status:'missing',detail:'Download local AI before starting.',model:'Fixture',language:'English'};
  let creates = 0;
  await page.route('**/api/meetings', route => { creates++; return route.abort(); });
  const push = await openPopup(page, state);
  await expect(page.getByText('Download local AI first.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Quicken' })).toBeDisabled();
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Set up local AI' }).click();
  const main = await opened;
  await expect(main.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(main.getByText('Local AI')).toBeVisible();
  await main.locator('summary').filter({hasText:'Cloud bot'}).click();
  await expect(main.getByLabel(/OPENAI API KEY/)).toHaveValue('');
  await main.close();
  state.settings.hasOpenaiKey = true; push();
  await page.getByLabel('Listen through').selectOption('meeting');
  await expect(page.getByText('Add a Recall key in Settings.')).toBeVisible();
  state.settings.hasRecallKey = true; push();
  await expect(page.getByText(/Start a test bridge in Settings/)).toBeVisible();
  expect(creates).toBe(0);
});

test('popup imports an agenda and starts a single rehearsal with recoverable audio and End', async ({ page, context }) => {
  const state = fixture();
  const push = await openPopup(page, state);
  await page.getByLabel('Listen through').selectOption('rehearsal');
  await page.getByLabel('Upload agenda', { exact: true }).setInputFiles({ name: 'agenda.md', mimeType: 'text/markdown', buffer: Buffer.from('Choose a project (3 min)\nAssign owners (7 min)') });
  await expect(page.getByLabel('Your agenda')).toHaveValue('Choose a project (3 min)\nAssign owners (7 min)');
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
  // Real popup UI and agenda parser, deterministic meeting/provider responses. No microphone or paid calls.
  let creates = 0;
  let input: any;
  const bridgeUrl = '/bridge#session=popup-fixture&token=fixture&rehearsal=1';
  await context.route('**/bridge', route => route.fulfill({ contentType: 'text/html', body: '<h1>Audio setup fixture</h1>' }));
  await page.route('**/api/meetings', async route => {
    creates++; input = route.request().postDataJSON();
    state.meetings = [{ ...input, id: 'popup-fixture', status: 'draft', currentAgendaIndex: 0, interventions: [], paused: false, bridgeConnected: false } as Meeting];
    await route.fulfill({ json: state.meetings[0] });
  });
  await page.route('**/api/meetings/popup-fixture/start', async route => {
    state.meetings[0].status = 'joining'; push();
    await route.fulfill({ json: { bridgeUrl } });
  });
  await page.route('**/api/meetings/popup-fixture/bridge', route => route.fulfill({ json: { bridgeUrl } }));
  await page.route('**/api/meetings/popup-fixture/end', async route => {
    state.meetings[0].status = 'ended'; push(); await route.fulfill({ json: state.meetings[0] });
  });
  await page.setViewportSize({ width: 380, height: 580 });
  await page.screenshot({ path: 'verification/popup-activation.png' });
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Start Quicken' }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  const audio = await opened;
  await expect(audio).toHaveURL(/\/bridge#session=popup-fixture/);
  await expect(page.getByText('Waiting for audio…')).toBeVisible();
  expect(creates).toBe(1);
  expect(input.mode).toBe('rehearsal');
  expect(input.processing).toBe('local');
  expect(input.agenda.map((a: any) => a.minutes)).toEqual([3, 7]);
  await audio.close();
  const reopened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open audio', exact: true }).click();
  await expect(await reopened).toHaveURL(/\/bridge#session=popup-fixture/);
  await page.getByRole('button', { name: 'End', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Activate Quicken' })).toBeVisible();
  await page.getByRole('button', { name: 'Activate Quicken' }).click();
  await expect(page.getByLabel('Your agenda')).toHaveValue(input.agenda.map((a: any) => `${a.title} (${a.minutes} min)`).join('\n'));
});

test('popup keeps the agenda and permits retry after activation fails', async ({ page }) => {
  const state = fixture(); state.settings.hasRecallKey = true; state.settings.publicBaseUrl = 'https://bridge.example.test';
  await openPopup(page, state);
  await page.getByLabel('Listen through').selectOption('meeting');
  await page.getByLabel('Meeting link').fill('https://meet.google.com/example');
  await page.getByLabel('Your agenda').fill('Resolve blockers (9 min)');
  let creates = 0;
  await page.route('**/api/meetings', route => { creates++; return route.fulfill({ json: { id: 'failed-fixture' } }); });
  await page.route('**/api/meetings/failed-fixture/start', route => route.fulfill({ status: 502, json: { error: 'Could not reach the meeting provider. Try again.' } }));
  await page.getByRole('button', { name: 'Start Quicken' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not reach the meeting provider');
  await expect(page.getByLabel('Your agenda')).toHaveValue('Resolve blockers (9 min)');
  await expect(page.getByRole('button', { name: 'Start Quicken' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start Quicken' }).click();
  await expect.poll(() => creates).toBe(2);
});

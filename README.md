# Quicken

A macOS meeting moderator for a school project. Upload an agenda, start a session, and let Quicken keep time, track open questions, clarify commitments, and gently bring the discussion back on topic. The floating chicken follows the session and gives you pause and stop controls.

## Run the app

The built Apple Silicon app is `release/mac-arm64/Quicken.app`. Open it in Finder. Keep it open during meetings. Only run one copy of the backend at a time; it uses local port 4317.

The local engine requires an Apple Silicon Mac (macOS 14.2+). This build was exercised on an 18 GB Mac; other memory sizes and macOS versions need testing. English transcription is supported.

From source, install Node 22.12+, Git, CMake, and Xcode with Swift 6.2 or newer. The first build fetches pinned FluidAudio and llama.cpp sources and compiles the native engines; later builds reuse them:

```sh
npm ci
npm run desktop
```

For the browser interface:

```sh
npm run build
npm start
# In a second terminal:
npm run open
```

`npm run open` opens an authenticated local URL without printing the credential. A bare localhost URL in a new browser does not grant access to your workspace.

## First test: microphone rehearsal

1. Open **Settings → Download · 3 GB**. The first setup downloads about 2.7 GB of model files; allow at least 4 GB free space. After setup, no internet connection or API key is needed for Quicken’s AI. Models are already installed on the development Mac. The app warms them when launched.
2. Create a meeting, paste or upload an agenda, and choose **Rehearsal**.
3. Use headphones. Click **Start microphone** in the audio window and grant microphone access.
4. Say “Quicken, what is the first item on our agenda?”
5. End the meeting in the main window to generate notes. Export downloads Markdown with the transcript and notes.

The **sample meeting** is a scripted replay with no API calls. It demonstrates controls and layout; it is not evidence of real AI or meeting performance.

## Optional cloud bot: join by meeting link

This preserved option uses paid cloud providers and is explicitly labeled **cloud**. It gives Quicken its own visible participant. Local mode instead speaks through your microphone connection. Choosing cloud mode is the only way to create a new cloud session; local AI never silently falls back to it.

Add an OpenAI API key with API billing and model access in **Settings → Cloud bot**. A ChatGPT subscription does not provide API credit.

1. Create a Recall.ai account using your accurate student-project details. The project website is https://meet-quicken.vercel.app/. Ask Recall support if its signup requirements do not fit a school project.
2. Add your Recall API key and its region in Settings. Match the region shown by your Recall dashboard.
3. In Settings, click **Start test bridge**. This uses `cloudflared` (installed on the development Mac; install elsewhere with `brew install cloudflared`). It creates and checks a temporary public HTTPS endpoint forwarding to this running app on port 4317. For a stable setup, run a persistent HTTPS tunnel and put its origin in **PUBLIC HTTPS APP URL**. A marketing website alone is not the bridge endpoint: `/bridge`, `/api/bridge/...`, and `/socket` must reach Quicken's server. Do not put your API keys in the website or chat.
4. Create a meeting, choose **Join a meeting**, and paste the actual meeting link.
5. Admit **Quicken · AI moderator** from the waiting room. Tell attendees it is an AI moderator that listens and transcribes.
6. End the session in Quicken when done. The app requests that the bot leave and generates notes.

Recall and OpenAI are paid services; configure spending limits in their dashboards. This app does not create subscriptions, buy credits, or embed provider credentials in its package.

## Local meeting audio: no provider accounts

This default meeting path uses the desktop app, the downloaded local models, headphones, and the free [BlackHole 2ch audio driver](https://existential.audio/blackhole/). It does not join as a separate participant: Quicken's voice is mixed into your meeting microphone.

1. Install BlackHole 2ch using its official installer (or `brew install blackhole-2ch` if you use Homebrew). Complete the system installer yourself and restart audio apps if needed.
2. Keep the Mac's normal output set to your **headphones**. Do not select BlackHole as your global system output: that would feed the meeting back into itself.
3. In Zoom or Meet, select **BlackHole 2ch as the microphone** and your **headphones as speakers**.
4. In Quicken, create a meeting and choose **On this Mac**. In the audio window, select your real microphone and BlackHole 2ch as the voice output.
5. Click **Start meeting audio**. Grant microphone and System Audio Recording access to Quicken in macOS. If permission is denied, use System Settings → Privacy & Security and reopen the app.
6. Verify both level meters: your microphone when you speak, and meeting audio when another participant speaks. Use the audio window's **Mute me** button to mute your voice both to Quicken and into the meeting. Zoom/Meet's own mute only affects what other attendees receive.
7. On ending or closing Quicken, restore your ordinary microphone in Zoom or Meet.

Quicken captures system audio except its own output, mixes that with your microphone for the model, and sends only your microphone plus the moderator's voice into BlackHole. It also plays the moderator to your normal output so you can hear it. Video tracks are stopped immediately and never transmitted or stored. Other audible applications can enter system audio capture, so close or mute unrelated media during a session.

This route still needs a real-device meeting test. BlackHole is not installed on the development Mac. Mixed speech is labeled “Participant”; local named-speaker attribution is not implemented. The preserved cloud bot path can receive speaker names from Recall.

## Meeting hints

While the native app is open, a small CoreAudio helper checks which supported apps are using a microphone every two seconds. When it sees Zoom, Teams, Webex, Chrome, Edge, Firefox, or Safari microphone activity, the chicken can suggest starting a session. This reads process activity metadata, not audio samples; it does not record or send audio until you start a session.

This is a best-effort hint, not proof of a meeting. Browser voice features can trigger it, and a meeting with no active microphone may be missed. It does not read browser URLs, scrape windows, or automatically join meetings. Toggle it in **Settings** or the **Quicken** menu. The native helper is bundled; source builds require the toolchain listed above.

## Controls

- **Activate** in the chicken popup opens a compact setup: choose a listening mode, paste or upload an agenda, and click **Start**. It remembers the last successfully used agenda and mode on this Mac. Meeting links are not remembered. Missing local models open setup; provider keys and the public bridge are required only for the cloud bot option. Local and rehearsal sessions still need the audio window's explicit Start button and device permissions. **Open audio** in the popup reopens that setup if needed.
- **Pause** prevents moderator speech while listening/transcription continue.
- **Stop speaking now / Quiet** immediately cancels an intervention.
- **Next topic** moves the agenda; **Add 5 minutes** extends the current topic.
- Intervention intensity and reason toggles affect when Quicken may speak.
- **Show chicken** restores the floating popup. Drag the chicken to reposition it.
- **End meeting** stops moderation and mutes model input immediately. The local audio queue is flushed before notes are generated, with a 15-second maximum; the cloud path retains a 3.5-second provider grace period. A timeout is surfaced instead of claiming all final words arrived. If AI notes fail, captured decisions and the transcript are preserved, and notes can be retried.

## Data and credentials

Notes and transcripts are stored as local JSON. The native app uses its macOS Application Support directory; development uses `.quicken/`. Provider API keys stay in the backend and are stored in a local settings file with owner-only file permissions. They are not encrypted with Keychain in this MVP. Do not share the data directory or `.env`.

New **On this Mac** and **Rehearsal** sessions use local AI. PCM audio travels only to the authenticated server on localhost and its native speech helper. Qwen runs in a private process bound to 127.0.0.1 with a random internal key. Llama and speech model loading are explicitly offline during meetings. No audio recording file is saved. Transcripts, notes, and up to 128 cached moderator voice clips are stored locally. Initial setup downloads model files from Hugging Face. System fonts avoid third-party font requests.

Shared models and cached voices live at `~/Library/Application Support/Quicken/LocalModels`. Both source and packaged runs reuse that folder. App state is separate: packaged sessions use the app’s data directory; source sessions use `.quicken/`. Local AI needs no Recall/OpenAI credentials. The optional cloud bot and older existing cloud sessions still use their configured providers. Old session records retain their original processing mode.
The public bridge uses a different, per-session credential. Ending the meeting revokes it. Normal app controls require the private workspace token. Never share an authenticated app URL.

## Implementation

Electron 45, React, TypeScript, Express and authenticated WebSockets, with bundled native helper executables. No Ollama, Python, or separate model server installation is required for the packaged app.

- **Speech:** Parakeet Realtime EOU 120M through FluidAudio/Core ML, using 160 ms chunks on the CPU/Apple Neural Engine. Input is 16 kHz mono PCM. Final utterances trigger moderation; the recognizer emits unpunctuated English.
- **Simple rules:** time reminders, fresh-question protection, explicit unresolved-question handoffs, cooldowns, duplicate suppression, pause/quiet/end, and speech interruption. Clear assignments with recognizable owners and deadlines are protected from redundant clarification.
- **Custom moderation:** quantized Qwen3-4B-Instruct-2507 through llama.cpp/Metal. Direct questions use a short answer path. Semantic assessment uses bounded recent context and supports topic drift and vague commitments. New speech cancels an in-flight response; stale responses are discarded.
- **Voice:** the installed macOS Samantha voice, streamed into playback as the first audio becomes available. Common timer phrases are cached. If Samantha is missing, install it in macOS Accessibility voice settings.
- **Notes:** the same local Qwen model, with bounded transcript sections and required verbatim evidence. Unsupported items are dropped, and moderator speech cannot become participant decisions. When a summary cannot be grounded, the app shows transcript excerpts. Long notes retain all sections; questions resolved in a later section can still appear in an earlier section.

The model is intentionally small. It can miss subtle drift, misunderstand commitments, or produce a weak response. Evidence checks reduce invented notes but do not prove every interpretation correct. The full transcript remains available. No broad meeting accuracy benchmark, multi-language support, or local speaker diarization is claimed.

Native dependencies and models are pinned; the Qwen download is SHA-256 verified. Versions, sources, model cards, and license copies are in `native/licenses/` and included in the app. Models download once instead of adding ~2.7 GB to every app update. Apple voice assets are supplied by macOS, not redistributed. See [the notices](native/licenses/NOTICE).

## Verification and development

```sh
npm run check          # TypeScript, production build, controller/API tests
npm run test:browser   # UI tests; requires npm start on port 4317
npm run package:mac    # Apple Silicon app bundle on an Apple Silicon Mac
```

The local smoke test accepts a prerecorded 16 kHz mono PCM WAV and never opens a microphone:

```sh
node --import tsx scripts/test-local.mjs /absolute/path/test-audio.wav
node --import tsx scripts/evaluate-local.mjs
node --import tsx scripts/test-local-browser.mjs /absolute/path/test-audio.wav
node scripts/test-local-voice.mjs
```

The first checks real local recognition, custom response, streamed voice, saved transcript and notes while blocking external HTTP calls in the Node process. Its playback acknowledgements are simulated; browser tests separately exercise actual Web Audio scheduling. The second runs a small synthetic text regression set. The browser script uses the real browser audio path with prerecorded input and muted output (run `npm run build` first). The voice script checks repeated uncached synthesis. Neither proves a real Zoom/Meet call or production accuracy. Reports are saved under `verification/`. The older `scripts/rehearse.mjs` tests the optional cloud provider and incurs API usage; do not use it for offline validation.

See [BUILD_STATUS.md](BUILD_STATUS.md) for actual validation and remaining work.

The default package configuration uses ad-hoc signing with timestamping disabled for a local school-project build. For public distribution, replace those settings with your own Apple signing identity and notarization credentials, enable timestamping, update the bundle identifier, review dependencies and model/provider licenses, and test on another Mac. This development build is not a notarized public release.

## Working with teammates

See [CONTRIBUTING.md](CONTRIBUTING.md) for the three-person GitHub workflow, local model setup and optional per-person API setup, pull requests, and updating your local app. The repository should start in this folder, alongside `package.json`, not in a parent folder containing other projects. There is no automatic app updater or hosted release pipeline yet.

# Quicken 0.2.0 — local AI build status

The Apple Silicon app is built at `release/mac-arm64/Quicken.app`. New Mac-audio and microphone-rehearsal sessions use local speech recognition, Qwen moderation, macOS voice, and local notes. No API keys or public bridge are required for these modes. The existing chicken, white/red/yellow interface, agenda uploads, controls, transcript, notes, Markdown export, sample replay, meeting hints, and explicitly optional cloud bot remain.

The app bundles its native runtimes. About 2.7 GB of model weights download once through Settings and are shared between source and packaged runs. They are already installed on this Mac. Local AI supports Apple Silicon and English; the development Mac has 18 GB RAM. Recognition emits unpunctuated text, and mixed meeting speech has no named-speaker attribution.

## Verified in this build

- Production TypeScript, frontend, server, and native builds succeed.
- 34 controller, API, transcript-format, and local moderation tests pass. Local regressions cover no-key operation, rejecting cloud audio for local sessions, one active local engine, final transcript flushing, discarding stale speech after Pause, timer reminders without an LLM call, interrupted generation, grounded notes, clear commitments, and startup port conflicts.
- All 11 browser scenarios pass: existing UI/sample/agenda/export flows, chicken activation and recovery, local setup versus optional cloud keys, streaming PCM capture, incremental voice playback, speech interruption, End flushing, and no capture merely from opening the Mac-audio screen.
- Six synthetic text scenarios exercise the real Qwen model and moderation controller: clear assignment, fresh question, missing deadline, explicitly deferred unanswered question, sustained drift, and resolved question. All pass the narrow expected behavior checks. These cases guided rule/prompt changes; they are not a held-out accuracy benchmark.
- A prerecorded question runs through the actual browser AudioWorklet, native Parakeet, local Qwen, streamed native voice, browser playback, final transcript, and notes. It correctly transcribes “quicken what is the first item on our agenda” and answers with the agenda topic. The latest run had **2,781 ms** from the recorded input ending to first scheduled voice playback, with a newly synthesized voice clip, nonzero decoded audio, no browser errors, and no external HTTP requests observed by the harness. A prior run with a cached voice clip measured 1,637 ms. These are individual warmed-model samples, not latency guarantees. Browser output was muted for testing; no physical microphone was opened.
- Four uncached native voice-generation runs complete successfully. The native writer handles duplicate end callbacks without resuming its completion twice.
- Local notes retain the correct summary and leave decisions/actions/open questions empty for the simple answered agenda question. A separate transcript with a Friday commitment correctly records that action. Unsupported note items are dropped; the full transcript is retained.
- Native app inspection shows the local engine ready, no-key setup panel, optional cloud settings collapsed, and the floating chicken. Popup activation flows are also covered by browser tests. No native microphone or live meeting was started during UI inspection.
- The packaged app and all four helper executables pass ad-hoc signature verification. The archive inspection found no `.env`, workspace data, or verification reports. Native runtime/model notices are included. A final update includes the voice completion fix.

Evidence: `verification/local-browser-synthetic.json`, `verification/local-semantic-evaluation.json`, and the reproducible scripts in `scripts/`. `verification/local-pipeline-synthetic.json` is an earlier server-path test with simulated playback acknowledgements; use the browser report for the latest full-path result. Older cloud/native reports belong to previous builds.

## UI simplification — November 2

The interface now uses short labels, visual mode cards, an agenda progress bar, and an audio-routing diagram. Secondary explanations and controls sit under Options, Moderator options, Details, Audio help, and the optional Cloud bot section. Connections is now called Settings. The chicken activation panel is shorter, with compact Activate/Start controls; accessible button names remain descriptive.

The existing 11 browser scenarios pass with the simplified interface. Visual checks cover the home screen, meeting, agenda upload, settings, activation popup, and audio setup. The new-meeting screen fits the minimum desktop width without horizontal overflow, and its collapsed frequency control still works. Screenshot evidence is in `verification/ui-settings.png`, `verification/ui-new-compact.png`, `verification/ui-audio-setup.png`, and `verification/popup-activation.png`. Audio routing and model behavior are unchanged; the real-meeting validation limits below still apply.

## Model comparison — November 2

**Decision: retain Qwen3-4B-Instruct-2507 Q4_K_M.** Neither smaller model preserved the existing moderation, custom-answer, and structured-notes features. Production model configuration and prompts were left unchanged. This is a no-regression choice: the larger model also failed some of the expanded checks, so this comparison is not a claim of production-grade meeting accuracy.

The real local runtime was tested on 42 synthetic scenarios, each repeated with two seeds: 26 meeting-tracking cases, 8 direct questions, and 8 notes cases. Models ran sequentially on this Mac with the same production controller, prompts, grounding, 8K context, one slot, Metal acceleration, and Q4_K_M quantization. The initial run disabled thinking. A second run gave each small model a 64-token thinking cap and additional output-token allowance.

| Model / configuration | Tracking checks | Custom-answer checks | Notes checks | Total checks | Median tracking latency |
|---|---:|---:|---:|---:|---:|
| 4B, current | 42/52 | 16/16 | 15/16 | 73/84 | 1.608 s |
| 1.7B, thinking off | 34/52 | 10/16 | 8/16 | 52/84 | 0.825 s |
| 0.6B, thinking off | 30/52 | 6/16 | 8/16 | 44/84 | 0.544 s |
| 1.7B, thinking capped at 64 tokens | 38/52 | 12/16 | 8/16 | 58/84 | 1.907 s |
| 0.6B, thinking capped at 64 tokens | 35/52 | 10/16 | 5/16 | 50/84 | 1.095 s |

Tracking latency begins with a completed transcript turn and ends with the controller assessment, including the 120 ms debounce. It excludes transcription and speech generation. Counts are targeted automated checks, not a measure of real-meeting accuracy. Manual inspection found additional faults: 1.7B fabricated a suggestion attributed to a participant, and 4B overstated a previously considered date as a confirmed date in a summary. The stricter eligibility gate was 90% overall checks, 85% per feature, at most a 3-point regression from baseline, at most one unnecessary interruption across repeats, and no worse p95 live-response latency. No tested configuration qualified.

The 1.7B model confused the speaker with the actual task owner and dropped explicit assignments/decisions from structured notes. The 0.6B model often echoed direct questions and missed unresolved questions or misclassified note sections. Brief thinking did not resolve these issues; it made 1.7B slower than the current model on live responses.

A separate test replayed the same recorded agenda question through real browser capture, Parakeet, the LLM, native speech synthesis and browser playback three times per model, with an empty application voice cache each run. Median time from the recording ending to first voice playback was **2.175 s (4B)**, **1.752 s (1.7B)**, and **1.534 s (0.6B)**. All nine transport tests completed with audio and saved notes and no observed external HTTP requests. This easy-question test does not establish semantic quality; the broader text cases above determine selection. These are warmed-model synthetic samples, not physical-meeting or latency guarantees.

Evidence and the decision are in `verification/model-selection.json`, `verification/model-comparison.json`, the two `verification/model-comparison-*-thinking64.json` files, and `verification/model-audio-comparison.json`. `model-comparison-preflight.json` is an explicitly excluded preflight whose fixtures were corrected before scoring. Candidate revisions, byte counts, and SHA-256 hashes are pinned in `verification/model-candidates.json`.

To reproduce from the project root:

```sh
python3 scripts/download-comparison-models.py
node --import tsx scripts/compare-local-models.mjs
QUICKEN_COMPARE_THINKING=64 node --import tsx scripts/compare-local-models.mjs Qwen3-1.7B
QUICKEN_COMPARE_THINKING=64 node --import tsx scripts/compare-local-models.mjs Qwen3-0.6B
node --import tsx scripts/compare-local-audio.mjs tests/audio/agenda-question.wav
node scripts/summarize-model-comparison.mjs
```

Quit Quicken before benchmarking so its loaded model does not compete for resources. The benchmark uses isolated temporary app state and no physical microphone. Candidate weights download to `~/Library/Caches/Quicken/model-comparison`; they are not bundled or selected by the app. The two evaluation downloads were removed after the comparison, reclaiming 1.50 GB. Quicken was reopened and Settings confirmed the existing Qwen3 4B model is Ready. The app and installed production models remain about 3.15 GB total.

## Apple and cloud benchmark — November 2

**Quicken's production model remains Qwen3 4B.** This work adds benchmark adapters and evidence only; it does not switch the app to Apple or a cloud model, remove weights, or rebuild the release.

Apple Intelligence was initially disabled, then became available after the user enabled it. The actual `SystemLanguageModel.default` on macOS 26.6.2 reported a 4,096-token context. A compiled Swift helper ran Apple's real on-device model, with native guided generation mapped from the existing JSON schemas. The helper is only in `scripts/` and is excluded from the shipped app.

The comparison reused the same 42 synthetic fixtures twice: 26 tracking cases, 8 direct questions, and 8 notes cases. Production controller, grounding and scoring stayed unchanged. Qwen was rerun as a fresh baseline. Apple and Qwen used temperature 0.1 and seeds 17/29; Apple's sampling was top-k 40. Cloud used GPT-6 Luna through the Responses API, standard service tier, reasoning disabled, temperature 0.1, no seed control, no retries, and `store=false`. Only synthetic fixture text went to the cloud API. The three providers use different tokenizers, schema implementations and caching behavior.

| Configuration | Tracking checks | Answer checks | Notes checks | Total | Median tracking | Median answer | Median notes |
|---|---:|---:|---:|---:|---:|---:|---:|
| Qwen3 4B, current prompts | 42/52 | 16/16 | 15/16 | 73/84 | 1.678 s | 0.710 s | 3.186 s |
| Apple, current prompts | 38/52 | 14/16 | 12/16 | 64/84 | 1.662 s | 0.614 s | 1.828 s |
| Apple, shorter experimental prompts | 36/52 | 14/16 | 14/16 | 64/84 | 1.722 s | 0.636 s | 1.941 s |
| GPT-6 Luna, cloud | 52/52 | 16/16 | 16/16 | 84/84 | 1.173 s | 0.902 s | 1.247 s |

Tracking/answer times include the existing 120 ms debounce and complete model response, not just the first token. Cloud times include network overhead. Tracking p95 was 2.096 s for Qwen, 1.863 s for Apple with current prompts, 2.130 s for Apple with shorter prompts, and 1.474 s for cloud. Cloud's median first text token across scored requests was about 0.635 s; a first token alone cannot establish a valid moderation decision. These are warmed runs on this Mac/network, not cold-start or service guarantees.

Apple frequently copied a testing-plan example from the existing instructions instead of evaluating the actual transcript. The app's quote checks rejected these unsupported interventions, making many silent cases pass. It also dropped explicit assignments from action notes, missed topic drift and vague owners, and named people for follow-up without a grounded assignment. The separate shorter-prompt experiment improved some action extraction but did not improve the total score. It was written after observing baseline failures and is not a held-out test. Both Apple variants passed keyword checks on some unhelpful or unsupported responses; counts should not be read as semantic accuracy.

Qwen retained the previous false-positive and summary limitations: for example, it overstated an initially considered date as a previously set date. Cloud had the best targeted results; manual inspection still found imperfect single-quote support for notes combining multiple rows and an unsupported gendered pronoun. Passing all 84 narrow checks does not establish perfect or real-meeting accuracy.

Nine additional browser trials used the same recorded agenda question, three per model, through real Parakeet recognition, model response, native voice synthesis and browser playback. Each used an empty application voice cache and isolated synthetic meeting storage. All nine passed. Median time from the recording ending to first playback was **2.083 s for Qwen**, **1.924 s for Apple with current prompts**, and **2.149 s for cloud**. Individual Apple runs ranged from 1.898 to 2.513 s; the small sample does not establish a stable speed advantage. Transcription and speech stayed local even in the cloud-model test. No physical microphone or meeting routing was exercised. Unexpected external HTTP was blocked; Apple's OS service traffic is outside the Node/browser HTTP instrumentation.

The 84 scored cloud text cases used 45,872 input and 4,714 output tokens, approximately $0.00694 at the published GPT-6 Luna standard rates; this estimate excludes access probes, warm-ups and audio trials. Credentials were read from the existing environment and were not copied to reports or code.

Evidence: `verification/apple-cloud-benchmark.json` includes timings, source hashes, limitations and manual review; raw outputs remain in `verification/model-comparison-Apple-Foundation-Models.json`, its `-compact` variant, `verification/model-comparison-Cloud-gpt-6-luna.json`, `verification/model-comparison-Qwen3-4B-Instruct-2507.json`, and `verification/apple-audio-comparison.json`.

Reproduce with Quicken closed and Apple Intelligence enabled:

```sh
node --import tsx scripts/compare-local-models.mjs Qwen3-4B-Instruct-2507
node --import tsx scripts/compare-local-models.mjs Apple-Foundation-Models
QUICKEN_APPLE_COMPACT=1 node --import tsx scripts/compare-local-models.mjs Apple-Foundation-Models
# The next two commands use OPENAI_API_KEY from the environment and incur API usage.
node --import tsx scripts/compare-local-models.mjs Cloud-gpt-6-luna
QUICKEN_COMPARE_CLOUD=gpt-6-luna node --import tsx scripts/compare-apple-audio.mjs tests/audio/agenda-question.wav
node scripts/summarize-apple-cloud-benchmark.mjs
```

Official references: [Apple Foundation Models](https://developer.apple.com/documentation/foundationmodels), [GPT-6 Luna settings and prices](https://developers.openai.com/api/docs/models/gpt-6-luna), and [Responses structured output](https://developers.openai.com/api/docs/guides/structured-outputs).

## Manual setup still needed for a real meeting

1. Install **BlackHole 2ch** from its official installer. It is not installed on this Mac.
2. Use headphones. Set the meeting app's microphone to BlackHole 2ch and its speakers to the headphones. Keep normal Mac output on headphones.
3. In Quicken, choose **On this Mac**, select the physical microphone and BlackHole output, then explicitly start meeting audio. Grant microphone and System Audio Recording permissions when macOS requests them.
4. Tell participants Quicken is listening/transcribing. Check that another participant can hear both you and Quicken. Restore the normal meeting microphone when finished.

Microphone rehearsal requires no BlackHole driver: activate the chicken, choose **Rehearsal**, enter an agenda, start Quicken, then click **Start microphone** in its audio window. If Samantha is absent on another Mac, install that English voice through macOS Accessibility voice settings. Another Mac must also download the models once.

## Practical limits and unfinished validation

- A real Zoom/Meet/Teams call, physical audio routing, cross-talk/echo behavior, and another participant hearing Quicken have **not** been verified. This is the remaining real-meeting validation step; synthetic tests do not establish it.
- Meeting detection remains a best-effort microphone-activity hint. It does not automatically record or join a call, and it can miss meetings or detect unrelated browser voice activity.
- The 4B model can misunderstand subtle context or miss an intervention. Rules reduce obvious redundant interruptions; evidence checks reduce fabricated notes, without guaranteeing correctness. Long notes are summarized in bounded sections, with unresolved questions scoped to each section.
- Long meetings, thermal/battery behavior, recovery on real audio-device changes, and operation on a second Mac still need testing.
- The app uses development ad-hoc signing, has no notarization or automatic updater, and is not yet a public distribution release. Follow `CONTRIBUTING.md` for source-based collaboration and rebuilding updates.
- The optional cloud bot still needs user-supplied OpenAI/Recall credentials, a public bridge, an authorized meeting link, and bot admission. None is needed for local mode. There is no cloud fallback.

See `README.md` for setup, architecture, data locations, and commands; `CONTRIBUTING.md` covers the teammate workflow.

## Expanded cloud comparison — November 2

Added actual GPT-6.1 Terra and GPT-5.4 nano runs using the unchanged 84-check suite. Terra passed 84/84 (tracking median 1.847 s); nano passed 75/84 (1.561 s). Earlier same-day controls were Qwen 73/84 (1.678 s), Apple 64/84 (1.662 s), and Luna 84/84 (1.173 s). Text controls were reused with verified unchanged fixture/harness hashes. All cloud calls used standard tier, reasoning none, synthetic data, and store=false. Nano is currently marked deprecated by its official model documentation.

Fifteen fresh interleaved browser/audio trials all passed. Median recording-end to first playback: Qwen 1.987 s; Apple 1.705 s; Luna 2.361 s; Terra 2.519 s; nano 2.310 s. Three repeats of one easy recorded question cannot establish general speech latency or meeting accuracy. Recognition and voice stayed local. No physical meeting was tested.

Luna offers the best measured cloud tradeoff here; Apple was quicker on the easy audio question but substantially weaker on targeted semantic checks. Production configuration remains Qwen. Evidence: verification/expanded-cloud-benchmark.json and verification/expanded-cloud-audio-comparison.json. Reproduce new text runs with scripts/compare-local-models.mjs Cloud-gpt-6.1-terra and Cloud-gpt-5.4-nano; the audio harness now accepts QUICKEN_AUDIO_MODELS (comma-separated IDs) and QUICKEN_AUDIO_REPORT. Run scripts/summarize-expanded-cloud-benchmark.mjs after all five audio model groups complete.

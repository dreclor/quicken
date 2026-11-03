# Quicken 🐔

A local AI meeting moderator for macOS. Upload an agenda, start listening, and Quicken can speak up with time reminders, clarifying questions, and nudges to stay on topic. Get your transcript and notes when you finish.

## Get started

You need an **Apple Silicon Mac**, macOS 14.2+, Node.js 22.12+, Git, CMake, and Xcode with Swift 6.2+.

```sh
npm ci
npm run desktop
```

The first build compiles the native tools. In **Settings**, download the models once (about **2.7 GB**). Local transcription, moderation, voice, and notes then run without API keys.

## Try it

1. Create a meeting and choose **Rehearsal**.
2. Paste or upload an agenda.
3. Use headphones, click **Start microphone**, and allow microphone access.
4. Ask: “Quicken, what is the first item on our agenda?”
5. End the meeting to generate and export notes.

The floating chicken gives you quick access to activation, pause, and stop controls. **Try sample** plays a scripted demo.

## Use it in a meeting

Choose **On this Mac** to listen locally. Sending Quicken’s voice into Zoom or Meet requires BlackHole 2ch and [audio setup](docs/SETUP.md#local-meeting-audio-no-provider-accounts).

Meeting hints suggest when to activate Quicken; recording starts when you choose. English is supported. Real meeting audio routing still needs validation.

An optional cloud bot can join by meeting link using Recall and OpenAI credentials. See the [setup guide](docs/SETUP.md#optional-cloud-bot-join-by-meeting-link).

## Work on it

```sh
npm run check        # Build and tests
npm run package:mac  # Create the standalone Mac app
```

Quit other copies of Quicken before launching a development build. The app has no automatic updater and is not yet notarized for public distribution.

- [Team workflow and updates](CONTRIBUTING.md)
- [Detailed setup and reference](docs/SETUP.md)
- [Test results and current limitations](BUILD_STATUS.md)
- [Dependency and model notices](native/licenses/NOTICE)

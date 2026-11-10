# Quicken 🐔

A private meeting assistant for macOS. Quicken listens to your microphone and meeting audio, shows suggestions in the chicken overlay, and saves a transcript and notes.

## Get started

You need an **Apple Silicon Mac**, macOS 14.2+, Node.js 22.12+, Git, CMake, and Xcode with Swift 6.2+.

```sh
npm ci
npm run desktop
```

The first build compiles the native tools. Quicken uses **Apple AI** when available (macOS 26+ with Apple Intelligence enabled). Settings offers **Open Settings** or **Download Qwen** when it isn’t. Apple mode needs a **224 MB** speech download; Qwen plus speech is about **2.7 GB**. Both run locally without API keys.

## Start a meeting

1. Open Quicken, click **Start**. Use **Add agenda** first if you want to include one.
2. Allow microphone and system audio access if macOS asks. Quicken uses your default microphone and captures meeting audio from your Mac.
3. Read suggestions in the chicken overlay. End the meeting to generate and export notes.

Use your regular microphone and speakers in Zoom or Meet. Suggestions are private text. Live meeting audio routing still needs validation.

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

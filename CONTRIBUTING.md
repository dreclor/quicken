# Developing Quicken together

This guide is for the project owner and two teammates. Keep one shared GitHub repository, use a separate branch for each change, and merge reviewed changes into `main`.

## Before sharing the repository

Use the folder containing this file and `package.json` as the repository root. Do not upload the parent Codex workspace. Start with a private repository and invite the two teammates in the repository's collaborator settings.

The included `.gitignore` excludes `.quicken/` (API keys, local tokens, transcripts and notes), `.env` and its variants, installed dependencies, compiled output, packaged apps, and common signing-key files. `.env.example` is an empty template and is safe to commit. Keep `package-lock.json` committed so all three developers install the same dependencies. Review the changed-file list before publishing; never force-add ignored files or commit real meeting exports. Git ignores do not remove files that were already committed.

The project is not yet a Git repository. When you are ready, initialize it here, review the files, and make the first commit:

```sh
git init -b main
git status --short
git add .
git diff --cached --stat
git commit -m "Initial Quicken MVP"
```

Then add the local repository in GitHub Desktop and click **Publish repository**, leaving **Keep this code private** checked. Alternatively connect the empty GitHub repository you created using its displayed remote instructions. Do not commit provider keys to GitHub, even in a private repository.

## What each teammate installs

1. An Apple Silicon Mac running macOS 14.2 or newer. The local AI build does not support Intel Macs. Allow at least 4 GB free for models, plus space for native builds. An 18 GB Mac was used for testing; other memory sizes are unverified.
2. GitHub Desktop and access to the shared repository. Clone it through **File → Clone Repository**. Cloning keeps the history and enables updates; downloading a source ZIP is not the collaboration workflow.
3. Node.js 22.12 or newer, including npm.
4. Xcode with Swift 6.2 or newer, Git, and CMake. A Command Line Tools installation is sufficient only if its Swift version meets that requirement. The first build fetches and compiles the pinned native dependencies.

Open Terminal in the cloned project folder, then:

```sh
npm ci
npm run desktop
```

`npm run desktop` compiles the native microphone-activity, streaming speech, local model, and voice helpers, builds the UI/backend, and launches Quicken. Only one Quicken backend can run at a time, on port 4317. Quit the packaged app before running the development copy.

## Local setup and optional API keys

| Activity | Required setup |
| --- | --- |
| Edit/build the app, unit tests, browser fixture tests, scripted sample | No provider key |
| Local microphone rehearsal | Settings → download speech or Qwen, microphone permission, headphones; no API keys |
| Local meeting audio captured on the Mac | Local models, BlackHole 2ch, headphones and macOS audio permissions; follow README device routing |
| Quicken joins by meeting link as a separate participant | OpenAI key, Recall key and matching Recall region, public HTTPS bridge, meeting link and bot admission |

Quicken defaults to Apple AI when available on macOS 26+. Otherwise Settings offers enabling Apple Intelligence or downloading Qwen. Apple mode downloads only speech (~224 MB); Qwen plus speech is ~2.7 GB. Choose Qwen explicitly under **Settings → Model** to keep using it. Download models once per Mac in **Quicken → Settings**. Both source and packaged apps share `~/Library/Application Support/Quicken/LocalModels`. Models are ignored by Git and not part of source commits. Local sessions do not need keys or a public bridge.

For the optional cloud bot only, add keys in **Quicken → Settings → Cloud bot**. OpenAI API billing is separate from a ChatGPT subscription. Recall has its own account and usage. Each teammate should use a separately managed key instead of copying someone else's personal key into the project. A team provider project with separate member credentials can be used if the team later wants shared billing; set that up in the provider account, not in this repository.

Keys are stored only on the local Mac, in owner-readable settings files. They are not bundled into the app or encrypted with Keychain in this MVP. A normal packaged launch stores data under macOS Application Support; source runs store it in `.quicken/`. Those two workspaces are separate, so switching between them may require adding keys again. Do not copy either workspace to teammates. Never put provider keys in `VITE_` variables or frontend source: those are exposed to the browser.

Recall mode also needs a public bridge so its bot can connect to your local app. **Settings → Start test bridge** uses a separately installed `cloudflared` command; each Mac needs its own running tunnel. Follow README for the persistent URL alternative. API keys alone do not complete meeting setup.

## Make a change

In GitHub Desktop:

1. Switch to `main`, choose **Fetch origin**, then **Pull origin** if offered.
2. Create a branch named for one change, such as `popup-controls` or `better-agenda-import`.
3. Open that clone in your editor or Codex and make the improvement. Coordinate before both people change the same area.
4. Run `npm run check`. For UI or audio-flow changes, run the browser tests below and manually try the relevant flow.
5. Review the changed files in GitHub Desktop. Commit with a description of the change, then **Publish branch** or **Push origin**.
6. Open a pull request into `main`. Explain the behavior before/after, include a screenshot for visual changes, and describe what was tested. Ask the project owner to review it.

Do not push experimental work directly to `main`. The owner reviews the pull request and uses **Squash and merge** after testing. A merge does not update anyone's installed app automatically. If the repository plan supports branch protection/rulesets, the owner can require pull requests and a review on `main`; otherwise follow this as the team's working agreement.

### Browser tests

Quit the desktop app first. Install the test browser once:

```sh
npx playwright install chromium
npm run build
npm start
```

Leave that server running. In a second terminal in the same folder:

```sh
npm run test:browser
```

These tests use samples and provider fixtures. They verify UI behavior without making a real call. Stop the server with Control-C before opening the desktop app again. Do not run tests against a workspace with an active meeting. Live meeting testing is a separate step with authorized participants and configured audio routing (or provider access for cloud mode).

## Get a coworker's merged improvements

Quit Quicken, then in GitHub Desktop switch to `main` and **Fetch origin → Pull origin**. Commit or otherwise save your own work on its branch before switching. In the project folder:

```sh
npm ci
npm run desktop
```

That launches the updated source version. For a refreshed standalone Mac app:

```sh
npm run package:mac
```

On Apple Silicon the result is `release/mac-arm64/Quicken.app`. Quit the old copy, replace it with the new copy in the same install location, and open it. Existing packaged-app settings and meetings remain in Application Support as long as the app identity/data path is unchanged. Back up that data privately before a change that migrates its format. Do not distribute your local data directory with the application.

The equivalent terminal update, from a clean checkout, is:

```sh
git switch main
git pull --ff-only
npm ci
npm run package:mac
```

If Git reports conflicting local changes, preserve and resolve them; do not use a hard reset just to get an update.

## Downloadable releases later

For convenient downloads, a teammate can package a reviewed `main` commit, attach a ZIP containing `Quicken.app` to a versioned GitHub Release, and share the release link. The release must contain the built app as an asset: GitHub's automatically generated **Source code (zip)** is only source code. Build separately on the matching Mac architecture when distributing the native helper.

The current app has local ad-hoc signing and has not been notarized or tested on another Mac. It is not yet a frictionless download-and-install release. Start with source builds for this team. Before distributing downloadable builds broadly, configure Apple Developer signing/notarization and test a downloaded build on a second Mac. An in-app **Check for updates** feature would also need a release/update service; none is implemented today.

GitHub documentation: [publish an existing project](https://docs.github.com/en/desktop/adding-and-cloning-repositories/adding-an-existing-project-to-github-using-github-desktop), [merge a pull request](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request), [link to release downloads](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases).

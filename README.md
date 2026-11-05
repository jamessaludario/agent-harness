# Agent Harness

An Electron desktop app that drives coding agents through pluggable adapters.
Layout and flow are modeled on the Claude desktop app: project folders and
sessions in a sidebar, a chat transcript, and a side panel for environment,
context and outputs.

## Run

```bash
npm install
npm start
```

Requires Node.js and, for the Claude adapter, Claude Code.

## Claude subscription (Pro / Max)

The `claude-code` adapter spawns the official Claude Code CLI, so your
subscription login is used by Claude Code itself. This app never sees or stores
credentials. On first launch a setup screen:

1. finds Claude Code (the desktop app's bundled copy, `~/.local/bin`, or `PATH`),
2. offers the official installer if it is missing,
3. runs `claude auth login` and shows a code box in the app.

## Features

- Project folders with multiple sessions each; `+` on a folder starts a new session there
- **New** screen with a folder dropdown (including "No folder")
- Extra folders per session (`--add-dir`)
- Streaming replies, collapsible tool calls, thinking/streaming animations
- Light blue / dark blue / system themes
- State saved between launches

## Installer and updates

```bash
npm run dist      # builds release/Agent Harness Setup <version>.exe locally
```

The installed app checks GitHub Releases on launch (and every 4 hours), downloads
new versions in the background, and shows a "restart" banner in the sidebar.
Updates only work in the installed app, not under `npm start`.

To ship a new version:

1. Bump `version` in `package.json` (e.g. `0.2.0`) and commit.
2. Tag and push: `git tag v0.2.0 && git push origin main v0.2.0`
3. The `Release` workflow builds the installer and attaches it to a GitHub Release.

Note: the updater can only read **public** releases. For a private repo, publish
releases to a separate public repo (change `publish.repo` in `package.json`) or
host the files elsewhere. Builds are unsigned, so Windows SmartScreen will warn
until a code-signing certificate is added.

## Layout

- `src/main/adapters/` - one file per agent; export `{ id, label, run(opts, onEvent) }`
- `src/main/setup.js` - detect / install / sign in to Claude Code
- `src/main/main.js` - window, IPC, run registry
- `src/renderer/` - UI

## Adding an adapter

Emit normalized events (`init`, `text-delta`, `tool-use`, `tool-result`,
`result`, `error`, `exit`) and register it in `adapters/index.js`.

## Known limits

- Headless mode cannot show interactive permission prompts, so you choose a
  permission mode up front ("Auto-accept edits" by default). Per-action approval
  is the next planned feature.
- Only the Claude Code adapter exists so far.
- On Windows, if `npm install` leaves Electron's `dist/` empty, unzip the cached
  download from `%LOCALAPPDATA%\electron\Cache` into `node_modules/electron/dist`
  and write `electron.exe` to `node_modules/electron/path.txt`.

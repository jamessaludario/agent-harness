# Rubick

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
npm run dist      # builds release/Rubick Setup <version>.exe locally
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

## Browser, terminal, agent picker, plan usage

- **Browser / Terminal** (top bar; Ctrl+` opens the terminal): a dock beside the
  chat. The browser keeps its sign-ins between launches. The terminal runs one
  PowerShell command at a time in the session's folder (click the path to change
  it); it is not a full PTY, so interactive programs won't work.
- **Agent / model / effort** selectors sit in the composer; effort maps to
  `claude --effort`.
- **Plan usage limits** (side panel) come from the `rate_limit_event` messages
  Claude Code emits, so they update after each message and no credentials are read.

## Memory bank

Open it from **Memory** in the sidebar. Entries are stored in `memory.json` in the app's data folder and
passed to the agent on every run as extra system prompt (rules, standards, decisions, preferences, notes
first, then skills; 16k character budget). Each entry can be limited to one project and switched on/off.

- **Manual:** + Add a rule, standard, decision, preference or note.
- **Skills:** *Import skill…* reads a `SKILL.md` (name/description front matter + body) into memory; you review
  it before saving. Long skills can be condensed with Haiku.
- **Self-learning** (Off / Suggest / Smart): only messages that state something lasting ("always", "never",
  "from now on", "we use"…) are considered. *Suggest* queues them as-is; *Smart* asks Haiku whether it is a
  durable rule and requires 70% confidence. Nothing learned is active until you press *Remember* under
  Review. Duplicates (and anything you dismissed) are never re-suggested, at most 20 wait at a time, unreviewed
  suggestions expire after 14 days, and accepted ones that are never used are flagged "unused" after 60 days.

## Attachments and slash commands

- **Attach:** the **+** in the composer adds files or a whole folder; you can also drop files on the composer or
  paste a screenshot. The agent reads them with its own file tools (up to 10 per message), and gets access to
  their folders for that run. Pasted images are saved as scratch copies and cleaned up after 7 days.
- **Skills from a zip:** *Import skill…* accepts a `.zip` containing `SKILL.md` plus templates or other files
  (at the zip root or inside one folder). The package is unpacked into the app's data folder and the agent is
  told where to read its templates. Zips are limited to 20 MB / 500 files, encrypted or Zip64 archives are rejected.
- **Slash commands:** type `/` in the composer to pick a skill (`/draft-ticket fix the login bug`); that skill's
  full text is sent with the request. `/memory` and `/new` are built in.

## Files pane

The folder icon in the top-right group opens the Files pane: tabbed previews on the left, and on the right the
session's folder (plus any added folders) as a tree with git markers (M modified, U untracked), a filter box
(type a name, or start with ? to search inside files) and a collapse-all button; ⋯ has refresh, reveal and copy
path. Code is syntax-highlighted with line numbers. Previews: markdown renders as a page (toggle to source), images show inline, text and code show with line
numbers, anything else offers *Reveal*. Open files refresh by themselves when they change, so a regenerated test
report updates live. File names in the chat (inline code like `ticket_runs/issue_1048/report.md`, or markdown
links to a path) become clickable when the file exists, and so do the entries under Outputs. Only files inside the
session's folders (and the app's own skill/attachment folders) can be previewed.

## Letting the agent use the browser pane

Each agent run is given a small local MCP server (`browser-mcp.js`, listening on 127.0.0.1 with a random per-launch
token) backed by the Browser pane, so the agent can navigate, read the page, click, type, scroll, screenshot and read
console errors. The pane opens by itself when the agent uses it, and you stay signed in there across launches.
Passwords and recovery codes are never typed by the agent (password fields are refused, and the agent is told to ask
you). Turn it off in **Settings → Let the agent use the browser pane**.

## Permissions and folders

Agent runs are headless, so they cannot pop up approvals. Anything blocked shows a card with one-click fixes:
**Always allow `gh *`** (saved under Settings → Allowed commands) or **Add folder X** when a file lives outside the
session's folders (the same as *+ Add folder* in the Environment panel). Both then continue the run.

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

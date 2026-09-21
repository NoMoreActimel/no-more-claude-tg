# claude-tg

Talk to your running Claude Code sessions from Telegram. One private bot, many sessions, only you.

```
 phone ── Telegram ── bot ──(long poll, outbound only)── daemon ──(unix socket, 0600)── tg CLI ── Claude session
                                                            │                                   ├─ Claude session
                                                            └ caffeinate · whisper · reports    └─ Claude session
```

- One **daemon** owns the bot (Telegram allows a single poller per token). Every Claude session on this
  Mac — whichever subscription account it is logged into — reaches it through a unix socket.
- A session joins by running the **`/tg` skill**: it registers under `<project emoji><task emoji> short name`,
  arms a background listener, and from then on reads and answers your Telegram messages.
- With **Threaded Mode** on, each session gets its own thread in the bot chat. Without it, everything
  shares one chat and you route by replying to a session's message (or `/sessions` → tap).
- Zero npm dependencies. Node ≥ 22.

## Daily use

In any Claude Code terminal, before you walk away:

```
/tg            (optionally: /tg fix loader)
```

Then in Telegram: write in the session's thread. Text, voice, photos, files. Claude replies there,
short, signed with the session name.

| In Telegram | |
|---|---|
| `/sessions` | who is connected — 🟢 idle & listening, 🟡 mid-task |
| `/ping` | (in a thread) is this session alive, anything queued |
| `/end` | (in a thread) disconnect that session |
| `/clean` | delete the threads of ended sessions |
| `/status` | bridge health, how many stranger updates were dropped |

Reactions on your messages: ✍ queued (session is busy) → 👀 the session has it.

## One-time setup

Already done on this machine: CLI linked to `~/.local/bin/tg`, skill in `~/.claude/skills/tg`, launchd
service, Stop hook, ffmpeg + whisper.cpp + model. What only you can do:

1. **Pair** — `tg pair`, open the printed link on your phone, press START. Valid 10 minutes.
2. **Thread per session** (recommended) — in @BotFather, open this bot's settings and enable topics /
   threaded mode for private chats (the API flag is `has_topics_enabled`; `tg status` shows `threads: on`
   once it took). New sessions pick it up within a minute, no restart.
3. **Lock the bot down in BotFather** — `/setjoingroups` → Disable. (The daemon also leaves any group
   it is added to.)
4. **Rotate the token** — it was pasted into a chat once. @BotFather → `/revoke`, then
   `pbpaste | tg set-token && tg stop && tg up`. Pairing survives a token change.

From scratch on another Mac: `brew install ffmpeg whisper-cpp`, put `ggml-large-v3-turbo.bin` into
`~/.config/claude-tg/models/`, `pbpaste | node src/cli.js set-token`, `node src/cli.js install`,
`tg service install`, add the Stop hook (below), `tg pair`.

## Security model

The goal: nobody but the owner can make a Claude session do anything.

- **Identity = numeric Telegram user id**, fixed at pairing. Not the @username (changeable,
  re-registrable) and not the phone number (bots never see it).
- **Pairing**: a 10-character code from `crypto.randomBytes`, shown only in the local terminal, valid
  10 minutes, single use; 3 wrong guesses lock that account out, 12 in total burn the code. It must also
  come from the expected @username (`expectedUsername` in config) — a second factor for that one moment.
  Until pairing succeeds the bot answers nobody and no session can register.
- **Every update** must pass `isFromOwner()`: owner id, not a bot, private chat whose id is the owner id.
  Anything else is dropped without a reply — a stranger cannot tell the bot is alive. Groups are left.
- **No inbound network surface.** The daemon only makes outbound HTTPS calls to Telegram. The control
  API is a unix socket (mode 0600) inside `~/.config/claude-tg` (mode 0700): no TCP port, nothing for a
  web page or another machine to reach.
- **Token** lives in `~/.config/claude-tg/config.json` (0600), never in this repo, and is redacted
  from every error and log line. Logs never contain message text.
- **Telegram content never touches a shell**: ffmpeg/whisper run via `execFile` with argument arrays;
  attachment names are sanitised and written only under the private inbox.
- **Uploads** only come from the private outbox the CLI stages into; the daemon refuses any other path.
- **Secret report links are off** (`tunnel.enabled: false`). If enabled: separate localhost listener,
  exact-match 256-bit tokens, 24 h expiry, cloudflared runs only while a link is alive.

`npm test` covers all of the above, including an end-to-end run of the real daemon + CLI against a fake
Telegram API with an impostor in the loop. Disabling the owner check makes 5 tests fail.

What this does **not** protect against: someone with your unlocked phone or Telegram account, or code
already running as your macOS user. Turn on Telegram two-step verification and a passcode lock.

## CLI

```
tg up                         start the bridge if needed; status; pairing link if unpaired
tg register --name "fix loader" --emoji 🐛 --project-emoji 🧬
tg listen                     block until a Telegram message arrives (run in background)
tg send "text"                message the user (signed)
tg send-file <path> [--caption …] [--as-file]
tg report <file.html> [--caption …] [--link] [--force]
tg bye                        disconnect this session
tg project-emoji [🔥] [--project <dir>]   pin a project's emoji; no emoji lists them
tg spawn --project <dir> --name "blogposts" [--task "…"] [--dry-run]
                              open a NEW claude session in a Terminal window; it connects itself
tg status | logs | stop
tg pair [--reset]
tg service install|uninstall  launchd agent (start at login, restart on crash)
tg install [config-dir …]     link the CLI, install the /tg skill
pbpaste | tg set-token
```

The session id comes from `CLAUDE_CODE_SESSION_ID`, so Claude never has to pass it around.

### Reports

`tg report x.html` refuses HTML that still loads local files (`src="plots/a.png"`, `fetch('data.json')`,
`file://…`) — on a phone those are simply missing. Once the page is self-contained it renders it in
headless Chrome (430 px wide, over a DevTools pipe) and sends:

1. a screenshot of the first screenful — the instant preview in the chat;
2. a **static snapshot** of the rendered page under the original file name: scripts already executed,
   canvases turned into images, scripts and inline handlers stripped.

Why the snapshot: Telegram's in-app HTML viewer on iOS does **not run JavaScript** (tested on the owner's
iPhone, 2026-09-21: a JS probe page stayed red). A JS-drawn report would be blank there; the frozen copy
scrolls and zooms like a normal page. Interactivity is gone, so reports should not hide content behind
tabs or hover. `--with-original` also sends the interactive file; if freezing fails, the full-page PNG
and the original are sent instead.

### How a session stays reachable

`tg listen` runs as a Claude Code background command and exits when a message arrives; that exit wakes
the session. Messages stay queued in the daemon until the listener acknowledges them, so a crash
between receiving and printing loses nothing. The Stop hook (`tg hook-stop`) blocks a connected
session from going idle without a listener:

```json
"hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "$HOME/.local/bin/tg hook-stop 2>/dev/null || true", "timeout": 5 } ] } ] }
```

### Starting a session from the phone

The daemon never starts processes — a Telegram message cannot launch anything by itself. But a session
you already connected can, on request: ask it "start a session in chatdhd called blogposts" and it runs
`tg spawn`, which opens an ordinary interactive `claude` in a new Terminal window (your normal settings,
no extra flags) that reads the skill and connects itself (~30 s). The prompt is passed through a file, so
nothing you type is interpreted by a shell. This needs at least one session already connected — leave
one running before you go.

## Limits worth knowing

- A **permission prompt** in the terminal cannot be answered from Telegram; the session tells you it is
  waiting at the laptop. After 2 minutes unanswered the bridge also says so in the thread.
- **Sleep**: the daemon holds `caffeinate -ims` while any session is connected. That does not survive a
  closed lid on battery — leave the laptop open and plugged in.
- **Voice**: ~5 s per note on this Mac; the first one after a reboot takes ~30 s (1.6 GB model load).
- Telegram bots can download files up to 20 MB and upload up to 50 MB.

## Files

```
~/.config/claude-tg/   config.json (token, owner id) · state.json · daemon.sock · daemon.log
                       inbox/ (your attachments, 7 days) · outbox/ · models/
src/bridge.js          all behaviour: auth gate, pairing, routing, queues, threads
src/daemon.js          poll loop + unix-socket API          src/cli.js     the `tg` command
src/auth.js            pairing + isFromOwner                src/report.js  lint + screenshots
src/voice.js           ffmpeg + whisper.cpp                 src/tunnel.js  secret links (off)
skill/tg/SKILL.md      what a Claude session is told to do
```

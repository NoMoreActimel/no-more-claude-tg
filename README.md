# no-more-claude-tg

**Your own private Telegram bot for your running Claude Code sessions.** Walk away from the laptop and
keep working with every session from your phone: text, voice notes, photos, files, reports, and the
permission prompts that would otherwise leave a session stuck at the desk.

```
 your phone ── Telegram ── your bot ──(outbound long-poll)── daemon on your Mac ──(unix socket)── Claude session
                                                                │                                  ├─ Claude session
                                                                └─ whisper · caffeinate · reports   └─ Claude session
```

- **One bot, all your sessions.** Each session that runs `/tg` shows up as `🧬🐛 fix loader`: a project
  emoji, a task emoji, a short name. Write to any of them; replies come back signed.
- **Only you.** The bot pairs with exactly one Telegram account and silently ignores everyone else.
  Nothing listens on the network; the daemon only makes outbound calls to Telegram.
- **Prompts on your phone.** A permission prompt in a connected session arrives as Allow / Deny buttons.
  Claude's own questions arrive as option buttons.
- **Reports that open on a phone.** `tg report x.html` sends a screenshot and a pre-rendered copy.
- Zero npm dependencies. macOS first (Linux works without sleep control, autostart and `tg spawn`).

## Setup (two minutes)

You need: a Mac with [Node 22+](https://nodejs.org) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code), a
Telegram account, and your own bot token.

1. **Create your bot.** In Telegram open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a
   username ending in `bot`. Copy the token it gives you (looks like `123456789:AAF…`). That token is the
   bot's password; never paste it into a chat.
2. **Install and run the wizard** (no dependencies to install):
   ```sh
   git clone git@github.com:NoMoreActimel/no-more-claude-tg.git
   cd no-more-claude-tg && ./bin/tg setup
   ```
   (Once the package is on npm: `npm install -g no-more-claude-tg && tg setup`.)
   It asks for the token (typed invisibly), checks it, saves it to `~/.config/claude-tg/config.json`
   (readable only by you), links the `tg` command, installs the `/tg` skill and three hooks into
   `~/.claude/settings.json` (merged, backup kept), starts the daemon at login, offers to set up voice
   transcription, and prints a pairing link.
3. **Pair.** Open the link on your phone and press START (or send the 10-character code to your bot).
   The account that does this becomes the only one the bot will ever talk to.

Recommended, in @BotFather afterwards: `/setjoingroups` → Disable (the bot has no business in groups),
and enable **topics for private chats** in the bot's settings so every session gets its own thread. `tg
status` shows `threads: on` once that took.

`tg doctor` checks every part and tells you how to fix what is off.

## Daily use

In any Claude Code session, before you walk away:

```
/tg                 (or: /tg fix loader — words after /tg become the session name)
```

Then in Telegram write to that session. Replies arrive signed with its name. Several sessions
connected? With topics enabled each has its own thread. Without, a plain message goes to the session that
wrote last; reply to a message to talk to another one, or pick with `/sessions`.

| In Telegram | |
|---|---|
| `/sessions` | who is connected — 🟢 idle & listening, 🟡 mid-task |
| `/ping` | is this session alive, anything queued |
| `/end` | disconnect this session |
| `/clean` | delete threads of ended sessions |
| `/status` | bridge health |

Reactions on your messages: ✍ queued (the session is busy) → 👀 picked up.

**Voice notes** are transcribed on your Mac (Whisper, free, any language) and echoed back so you can catch
mishearings. **Photos and files** land in a private inbox and are handed to the session as paths.

### Prompts that used to need the laptop

- **Permission prompt** (a command, a file write, …) in a connected session → a message with
  **✅ Allow / ❌ Deny**. The session waits up to ten minutes for your tap; after that the prompt is
  shown in the terminal as usual. Taps from anyone but you are ignored.
- **Questions from Claude** (the multiple-choice dialog, `AskUserQuestion`) → the options as buttons;
  tap one or reply with free text. Claude continues with your answer. Connected sessions can also ask
  directly with `tg ask`. (Claude Code has no hook for its question dialog; the bridge catches it through
  the permission hook and hands the answer back as the tool's result — verified on 2.1.288.)
- **Waiting alerts.** If a connected session is stuck on something only the laptop can answer, you get
  one message saying so.
- **Starting a session from the phone.** Ask any connected session "start a session in my-app called
  blogposts" and it runs `tg spawn`, which opens a normal `claude` in a new Terminal window there. A
  folder Claude Code has never opened first gets a "Trust the files in it?" button; nothing launches
  without your tap. Nothing can start a session from a bare Telegram message — only a session you already
  connected can, on your request.

### Reports

`tg report page.html` refuses HTML that still loads local files (`src="plots/a.png"`, `fetch('data.json')`),
because on a phone those are missing. A self-contained page is rendered in headless Chrome at phone width
and sent as a screenshot plus a **static snapshot**: scripts already run, canvases turned into images,
scripts stripped. Telegram's in-app viewer on iOS does not run JavaScript, so that snapshot is what you
can actually read; `--with-original` also sends the interactive file for later.

## Security model

- **Identity is the numeric Telegram user id** captured at pairing — not the @username (changeable) and
  not the phone number (bots never see it).
- **Pairing** uses a 10-character code from `crypto.randomBytes`, shown only in your terminal, valid 10
  minutes, single use; 3 wrong guesses lock an account out, 12 burn the code. Optionally the pairing
  message must also come from a @username you named during setup. Until pairing succeeds the bot answers
  nobody and no session can connect.
- **Every update** must pass one gate: owner id, not a bot, private chat whose id is the owner id.
  Anything else is dropped without a reply, so strangers cannot even tell the bot is alive. Added to a
  group, the bot leaves.
- **No inbound network surface.** Outbound HTTPS to Telegram only. Sessions and hooks reach the daemon
  through a unix socket (mode 0600) in `~/.config/claude-tg` (mode 0700).
- **Permission decisions** come only from taps on the buttons in that private chat; a typed reply to a
  permission question is refused.
- **The token** stays in `config.json` (0600), is redacted from every error and log line, and logs never
  contain message text. Telegram content never touches a shell (`execFile` with argument arrays);
  attachment names are sanitised; uploads come only from a private outbox the CLI stages into.

What this does not protect against: someone holding your unlocked phone or Telegram account, or code
already running as your macOS user. Turn on Telegram's two-step verification and a passcode lock.

## Commands

```
tg setup                      first run: token, install, daemon, voice, pairing
tg setup voice [--openai]     set up transcription later (local Whisper, or an OpenAI key)
tg doctor                     check every part and how to fix what is off
tg up / status / logs / stop  daemon control
tg pair [--reset]             (re)pair with a Telegram account

# inside a Claude Code session (the /tg skill does this for you)
tg register --name "fix loader" --emoji 🐛 --project-emoji 🧬
tg listen                     block until a message arrives (the skill runs it in the background)
tg send "text"                message you, signed with the session name
tg ask "question" --option A --option B     ask you with buttons; prints the answer
tg send-file <path> [--caption …] [--as-file]
tg report <file.html> [--caption …] [--with-original]
tg spawn --project <dir> --name "blogposts" [--task "…"]
tg project-emoji [🔥]         pin a project's emoji (no emoji: list them)
tg bye                        disconnect this session

tg install | uninstall [--purge]      link the CLI, install skill + hooks / remove them
tg service install | uninstall        launchd (start at login, restart on crash)
pbpaste | tg set-token                replace the bot token
```

## How it works

A single daemon owns the bot (Telegram allows one poller per token). Every session on the machine talks
to it over the unix socket, so it does not matter which Claude account a session is logged into.

`tg listen` runs as a background command inside the session and exits when a message arrives; that exit
wakes the session, which reads the message as the command's output. Messages stay queued in the daemon
until the listener acknowledges them, so nothing is lost if the session is mid-task or crashes between
receiving and reading. Three hooks in `~/.claude/settings.json` keep a connected session reachable:

| Hook | What it does |
|---|---|
| `Stop` | refuses to let a connected session go idle without a listener armed |
| `PermissionRequest` | relays the prompt to Telegram and returns your Allow/Deny — or, for Claude's question dialog, the option you tapped (up to 10 min) |
| `Notification` | sends one "waiting at the laptop" alert for prompts it cannot relay |

Hooks print nothing for sessions that are not connected, so the rest of your Claude Code use is
unchanged. `tg uninstall` removes exactly these three.

While any session is connected the daemon holds `caffeinate -ims`, so the Mac does not idle-sleep. A
closed lid on battery still sleeps it — leave it open and plugged in.

## Voice

`tg setup` offers local Whisper: `ffmpeg` + `whisper-cpp` from Homebrew and a one-time 1.6 GB model
download (`ggml-large-v3-turbo`, multilingual). A voice note takes a few seconds on Apple Silicon, the
first one after a reboot ~30 s. No audio leaves your machine.

Prefer the cloud? `tg setup voice --openai` stores an OpenAI key and uses `gpt-4o-mini-transcribe`
(about $0.003 per minute of audio — a voice note costs well under a cent).

## Troubleshooting

- `tg doctor` first. It checks Node, token, pairing, daemon, service, PATH, skill, hooks, voice, browser.
- Daemon log: `tg logs` (`~/.config/claude-tg/daemon.log`; never contains message text).
- "another process is polling this bot token (409)": two daemons (or another tool) use the same bot.
  One bot = one daemon.
- The session does not react to my message: `/ping` it. 🟡 means it is mid-task; your message is queued.
  If `/ping` says the process is gone, the terminal was closed.
- Voice note refused: `tg setup voice`.
- Permission prompt shown in the terminal, not on the phone: the session is not connected (`/sessions`),
  or hooks are missing (`tg doctor`).
- Moved the repo? `tg doctor` shows the hooks pointing at the old path; `tg install` rewrites them.
- You are back at the laptop and a session seems stuck: it is waiting for your tap on the phone (up to
  10 minutes). Tap there, or send `/end` to that session in Telegram, and the prompt appears locally.
- The question on the phone says "the session stopped waiting": the command that asked was interrupted
  or hit a timeout before you answered. Ask the session again.

## For AI agents

If a user asks you to set this up for them: clone the repository (or `npm install -g no-more-claude-tg`
once published), then run `./bin/tg setup` *in a terminal they can see* — it needs their bot token typed in and their tap on the pairing
link; do not ask them to paste the token into the chat. Afterwards, the `/tg` skill in
`~/.claude/skills/tg/SKILL.md` tells any session how to connect and how to behave on a phone-sized
screen: short messages, `tg ask` for decisions, `tg report` for anything visual.

## Files

```
~/.config/claude-tg/   config.json (token, owner id) · state.json · daemon.sock · daemon.log
                       inbox/ (your attachments, kept 7 days) · outbox/ · models/
src/bridge.js          all behaviour: auth gate, pairing, routing, queues, threads, questions
src/daemon.js          poll loop + unix-socket API         src/cli.js      the `tg` command
src/hooks.js           PermissionRequest/Notification      src/setup.js    wizard, hooks merge, doctor
src/auth.js            pairing + isFromOwner               src/report.js   lint + screenshots + snapshot
src/voice.js           Whisper / OpenAI                    src/tunnel.js   expiring links (off by default)
skill/tg/SKILL.md      what a connected session is told to do
```

`npm test` runs the suite, including the real daemon and CLI against a fake Telegram API with an impostor
in the loop and the hooks relaying prompts end to end.

MIT © NoMoreActimel

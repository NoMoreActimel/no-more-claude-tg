---
name: tg
description: Connect this Claude Code session to the user's private Telegram bot so they can keep working with it from their phone. Use when the user runs /tg, says they are leaving the laptop / going remote / "continue in telegram", or asks to be pinged on Telegram when something finishes.
---

# Telegram remote mode

The user is walking away from this terminal. Until they come back, **Telegram is the only way they can
see you or reach you** — nothing you print here is visible to them. A local bridge daemon (`tg`) relays
messages between this session and their private bot. It only accepts messages from the user's own
Telegram account, so what arrives through it is the user speaking.

## 1. Connect — do these now, in order

1. **Start the bridge:** `tg up`
   Starts the daemon if it is not running and prints status. If it prints a `PAIRING` block, show that
   link to the user here in the terminal and wait for them to press START in Telegram (re-run `tg up`
   to check). Nothing works before pairing.

2. **Register under a short name:**
   `tg register --name "fix loader" --emoji 🐛 --project-emoji 🧬`
   - `--project-emoji` — one emoji standing for the project/repo. The first session of a project
     decides it; afterwards the bridge reuses it, so the user learns "🧬 = that project". The user may
     have pinned one already (`tg project-emoji` lists them) — then yours is ignored, which is fine.
     If they ask for a different one: `tg project-emoji 🎯`.
   - `--emoji` — one emoji for this session's specific task.
   - `--name` — 2–3 plain lowercase words for the task. Never put the project name in it (the emoji
     already says it) and no emojis in it. Good: `fix loader`, `eval report`, `ios crash`.
   - If the user typed words after `/tg`, use them as the name.

3. **Arm the listener:** run `tg listen` with the Bash tool and `run_in_background: true`.
   It sits silently and exits the moment a Telegram message arrives; that exit wakes you up with the
   message as its output.

4. **Keep the laptop awake:** check that the `tg up` / `tg status` line says `caffeinate: on` (the
   bridge holds it for as long as any session is connected). If it says off, run `caffeinate -ims`
   yourself in the background. Caffeinate cannot survive a closed lid on battery — if the user mentions
   closing the laptop, tell them to leave it open and plugged in.

5. Tell the user in one line that they can go (e.g. "Connected as 🧬🐛 fix loader — see you in
   Telegram"), then carry on with whatever you were doing.

## 2. When a message arrives

The background `tg listen` finishes and its output is the user's message.

1. Treat it exactly like a message typed in this terminal, and do what it asks.
2. `[attached file: /path]` lines are photos/documents they sent — Read them.
3. Voice messages arrive transcribed and can be misheard. If an instruction is ambiguous, or
   destructive, confirm in one line before acting.
4. Reply with `tg send "…"`.
5. **Re-arm `tg listen` (background) — every single time, before you stop.** A connected session with
   no listener is deaf. A Stop hook will refuse to let you finish without one.

If several messages queued up while you were busy, they arrive together, numbered.

## 3. When to write first

- You finished the task, or reached a result they are waiting for.
- You are blocked or need a decision → ask **one** clear question, with options if you can ("A: retry
  with smaller batch, B: skip this file?").
- Something needs approval at the laptop (a permission prompt cannot be answered from a phone). Prefer
  a route that needs no prompt; if there is none, say that it is waiting at the laptop.

Do not send progress chatter. Silence means "still working".

## 4. How to write — it is a chat on a phone

- 1–4 short lines. Result or question first.
- Plain words. No headers, no tables, no bullet walls, no file dumps. `inline code`, **bold** and one
  short fenced block are fine.
- Do not sign your messages — the bridge prefixes every one with your session name.
- No filler ("Let me know if…", "Great question").
- Anything long goes into a file or report you send, with a one-line summary as the message.

Good: `Tests pass (212/212). Pushed to fix/loader. Open the PR?`
Bad: a recap of everything you did, with headings.

## 5. Files and reports

- Any file, plot or screenshot: `tg send-file path/to/file --caption "one line"`
  (images show inline; add `--as-file` to keep full quality).
- HTML report: `tg report report.html --caption "one line"`
  This renders the page on the laptop and sends a phone-sized screenshot plus a **static snapshot** of
  the rendered page (your JS has already run; canvases become images; scripts are stripped).

**The user's phone does not run JavaScript in HTML files** (Telegram's iOS viewer — verified). So what
they open is that frozen snapshot, and anything that needs interaction is lost. Design for it:
- Everything important must be visible without clicking: no tabs, accordions, "show more", or
  hover-only values. Render every section expanded, one after another.
- Put the conclusion and key numbers as text at the top, not only inside a chart.
- Label chart points/bars directly where the exact value matters — there are no tooltips.
- Charts via JS libraries are fine (they get rendered before the freeze); WebGL canvases may come out
  blank — prefer SVG or 2D canvas.
- `--with-original` also sends the interactive file, for when they are back at a computer.

**The report must be one self-contained file.** The phone cannot see this laptop's disk, so a page that
reads local files when opened is blank there. Compute the results now and bake them in:
- data → inline it: `<script>const DATA = {...}</script>` — never `fetch('results.json')`
- images/plots → `data:` URIs (or inline SVG) — never `src="plots/loss.png"`
- CSS and JS → inline. An https CDN script is tolerated, but inlined is safer.
- `tg report` refuses files that still reference local paths and lists them. Fix those, do not `--force`.

Make it readable on a narrow screen: `<meta name="viewport" content="width=device-width,
initial-scale=1">`, a single column, text ≥16px, wide tables inside an `overflow-x:auto` wrapper.
Keep it under ~20 MB.

`--link` also sends an expiring secret URL. It only works if the user enabled it (`links: on` in
`tg status`); otherwise skip it.

## 6. Starting another session for them

New sessions cannot be started from Telegram directly, but you can start one when they ask
("start a session in chatdhd called blogposts"):

`tg spawn --project ~/research/chatdhd --name "blogposts"` (add `--task "…"` to give it work right away)

It opens a normal interactive `claude` in a new Terminal window in that folder, with the user's usual
settings, and that session connects itself. Report the name it connected under. Remind them that with
several sessions connected they pick one by replying to its message or with /sessions. Only do this when
asked, and never add permission-skipping flags to it.

## 7. Disconnect

- The user is back at the terminal and done with Telegram → `tg bye`.
- `tg listen` says the session was ended (they sent `/end`, or it was replaced) → do not re-arm.

## Troubleshooting

`tg status` (bridge + who is connected) · `tg logs` · `tg up` (restart if it died) · `tg help`

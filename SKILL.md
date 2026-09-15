---
name: ask-panel
description: Ask one question to several logged-in AI web chats at once (ChatGPT, Claude, Gemini, Grok, DeepSeek, Perplexity) by driving a background Chrome over CDP, then synthesize their answers into one organized answer. Use when the user says ask AIs / ask the AIs / ask other AIs / ask everyone / ask the panel / run the panel / AI panel, or wants a second opinion from other models, a cross-check of an answer, or to know what the other models say. No API keys - it drives real logged-in browser sessions.
---

# ask-panel

Puts one question to several AI chat sites in parallel through a Chrome you are
already signed into, then hands you every answer as JSON so you can write one
synthesis. No API keys, no per-token cost. Text is delivered as a synthetic
paste, never typed character by character.

```bash
S=~/.claude/skills/ask-panel/scripts/panel.mjs
node $S --help
```

## 1. Check the browser is alive

```bash
curl -s http://127.0.0.1:9333/json/list | grep -c '"type": "page"'
```

```bash
node $S probe
```

`probe` is read-only and must show an `input=` selector for every site.
`send=MISSING` on an empty composer is normal: send buttons only exist once
there is text. If the port is dead, see **Setup** below.

## 2. Ask

```bash
node $S run "<question>" --out /tmp/panel.json 2>/tmp/panel.log
```

Typically 30-100s. To carry on working while it runs, append `&` and check
`tail -3 /tmp/panel.log` whenever you like.

**Use `--out`, not `> file`.** Progress goes to stderr and the payload to
stdout, so `> file 2>&1` interleaves them into something that is not valid JSON.
`--out` writes the payload directly and cannot be corrupted that way.

Split it up if you prefer: `ask` returns in ~10s, then `status`, then
`collect --out <path>`.

### Fire and forget (default)

Do not block on a panel run and do not poll it. Start it detached, then get on
with something else:

```bash
nohup node $S run "<question>" --out ~/.ask-panel/last.json > /dev/null 2>~/.ask-panel/last.log &
```

It survives the terminal closing, and it archives itself on completion. Check it
only when the user asks:

```bash
node $S check --out ~/.ask-panel/last.json
```

`check` is instant and never touches the browser. It prints either
`DONE in 59.7s | ChatGPT=ok Claude=ok ...` or `RUNNING | <last log line> | log
idle 3s`, and warns if the log has been idle over two minutes.

**Never `sleep` waiting for a run.** One `check` is the whole interaction: if it
says RUNNING, say so in one line and do something else. Never re-run the
question to find out whether the first one finished - that double-posts to the
user's real account.

### Follow-up questions

```bash
node $S run "<follow-up>" --continue --out /tmp/panel2.json 2>/tmp/p2.log &
```

`--continue` asks in the *same thread* on each site, so every model still has
its own previous answer in context. Shorter prompts, better answers.

Before running a follow-up at all, check the archive: if the detail is already
in a saved answer, read it from disk instead of spending a rate limit.

## 3. Read the result

Every site returns a `status`. Check it before using any text.

| `status` | Meaning | What to do |
|---|---|---|
| `ok` | Real answer extracted | Use it |
| `empty` | Site produced nothing usable, `text` is `""` | Exclude it, say so |
| `no-tab` | No tab open for that site | Exclude it, say so |
| `error` | Tab or CDP failure, see `why` | Exclude it, retry that site |

Two fields qualify an `ok`:

- `fallback: true` - text came from the page's `main` region, not a real answer
  node. Plausible but unverified. **Distrust it and say so.** It is not counted
  as an answer in the archive header.
- `recovered: true` - the answer was blank and one reload rehydrated it. Genuine.

`settle` (`stable` / `empty` / `straggler-deadline` / `timeout`) says why polling
stopped. `submit` says how the question was sent: `enter#1` is the normal case,
`click:<sel>#2` means Enter failed and the retry clicked, `unverified` means it
never left the composer.

Never treat a short `text` as an answer without checking `status`. A failed site
used to return the question echoed back plus a "can make mistakes" disclaimer,
which reads exactly like an answer and poisons a synthesis.

## 4. Synthesize

Not a table of "AI X said Y". Write the actual answer, organized by substance,
using agreement as a confidence signal:

- Lead with what is solidly established (most models agree, reasoning holds).
- Then contested points, naming who disagrees and why.
- Then single-source claims, flagged as unverified.
- Call out anything confidently wrong, and any model or product name you cannot
  verify exists - these models hallucinate plausible-looking names.
- Name any site that returned `empty`, `no-tab` or `error`, so the user knows
  the panel was five, not six.

Sanity-check facts yourself. Several models agreeing is weak evidence when they
share training data and cite the same sources.

## Presenting a run

The synthesis is written by you, the agent. No script turns six answers into one.

| Ask | What to produce |
|---|---|
| "show panel" | write the organized answer to a `.md`, render with `--synthesis`, open the page. The answer leads; the six answers sit beneath it as evidence. |
| "answer" | the same organized answer, as plain text in the terminal. No page. |
| (no synthesis yet) | `report --open` alone shows the six raw answers with no lead. |

```bash
node $S report --from ~/.ask-panel/last.json --synthesis /tmp/syn.md --open
```

Each evidence card keeps its status badge and a link to the live thread, so any
claim in the synthesis can be checked against its source.

## Runs are archived automatically

Every run is saved to `~/.ask-panel/runs/<timestamp>-<slug>/` as `run.json`
plus a readable `answers.md`, and indexed in `INDEX.md`. The raw answers are the
expensive part of a run, so they are kept by default; `--no-archive` opts out
and `ASK_PANEL_HOME` or `--archive-dir` moves them.

The archive deliberately lives **outside** this skill directory: it holds the
user's questions and live URLs into their logged-in accounts, and must not sit
in a folder that might be published or committed.

`collect` re-reads whatever the tabs show *now*, so a tab that has navigated
away loses its answer. The run's own JSON is authoritative - rebuild from it
with `node $S archive --from <run.json>`.

## Setup

Needs a Chrome with remote debugging enabled, signed in to the sites.

> **Use a dedicated Chrome profile.** An open debugging port gives any local
> process full access to every cookie and session in that profile. Do not point
> it at your everyday browser profile.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9333 --user-data-dir="$HOME/.ask-panel/chrome" &
```

Then sign in to each site once in that window and leave one tab per site open.
Sessions persist, so this is a one-time step. `--port` or `PANEL_CDP_PORT`
changes the port.

Do not bring that window to the front. The tool un-throttles the tabs instead,
which is renderer-side only.

## Why the tabs must be un-throttled

These are background tabs that are never fronted. Chrome reports
`document.visibilityState === 'hidden'` for them and throttles rAF, CSS
transitions and streaming renders. Two real failures came from exactly that:

- Claude's send button stayed at `opacity: 0; visibility: hidden` forever,
  because its fade-in transition never ran, so the question sat in the composer.
- ChatGPT finished a response server-side and left an assistant node with no
  text in it at all.

`Tab.connect()` therefore calls `Emulation.setFocusEmulationEnabled` and
`Page.setWebLifecycleState: active` on every tab before touching it. This does
not raise the Chrome window. **Do not remove it.** If sites start failing with
blank answers or stuck composers, check this first.

## Layout

| File | Contents |
|---|---|
| `scripts/sites.mjs` | per-site selectors - **the only file that needs regular upkeep** |
| `scripts/cdp.mjs` | DevTools transport, tab discovery, un-throttling |
| `scripts/page.mjs` | functions injected into the page |
| `scripts/ops.mjs` | submit / poll / extract |
| `scripts/archive.mjs` | saving runs |
| `scripts/args.mjs` | argument parsing |
| `scripts/panel.mjs` | CLI |
| `test/panel.test.mjs` | unit tests, no browser needed |

```bash
node --test test/
```

## Per-site quirks

| Site | Paste path | Submit |
|---|---|---|
| ChatGPT | `execCommand` into `#prompt-textarea` | Enter |
| Claude | `execCommand` into ProseMirror | Enter (needs un-throttled tab) |
| Gemini | `execCommand` into Quill `.ql-editor` | Enter |
| Grok | native value setter on textarea | Enter |
| DeepSeek | native value setter | Enter |
| Perplexity | Lexical rejects synthetic paste, so a fresh question uses the `?q=` URL | self-submits |

Perplexity's query URL always opens a new thread, so `--continue` falls back to
the DOM path for it rather than silently losing that site's context.

Gemini sometimes A/B tests, rendering two candidate answers hidden behind
"Choice A" / "Choice B". Extraction reads `innerText || textContent` and keeps
the longest, because `innerText` is `''` for a CSS-hidden node.
**Never click "Choice A" to reveal one: that casts a rating vote on the user's
real account.**

## When a site fails

1. `node $S probe` - did its `input=` selector go MISSING? The site reskinned;
   update that one entry in `scripts/sites.mjs`.
2. `node $S dump --sites <site>` - read the raw page text. Look for a login wall
   or a rate-limit banner.
3. Retry just that site: `node $S run "<q>" --sites <site>`.
4. Retry at most twice. Then record it as failed, report it, and move on.

## Rules

- These are real, logged-in accounts, usually free tier. They rate-limit. Keep
  questions short and never re-run the panel to iterate on a script.
- Never re-submit to rescue a blank answer. The thread already exists
  server-side; re-asking double-posts. Reload only, which the tool does once
  per site automatically.
- Never click a rating, feedback, consent, or upgrade button on any site.
- Do not bring the Chrome window to the front.
- Do not save transcripts into the user's project folders unless asked.
- Automating logged-in consumer accounts may conflict with a provider's terms of
  service. That is the operator's decision to make knowingly.

# ask-panel

Ask one question to several AI web chats at once - ChatGPT, Claude, Gemini,
Grok, DeepSeek, Perplexity - and get every answer back as JSON.

No API keys and no per-token cost: it drives a Chrome you are already signed
into, over the DevTools Protocol. Six sites in parallel, typically 30-100
seconds for a short question.

```bash
node scripts/panel.mjs run "What am I missing about X?" --out /tmp/panel.json
```

```json
{
  "question": "...",
  "elapsedSec": 29.8,
  "results": [
    { "site": "chatgpt", "status": "ok", "chars": 159, "text": "...", "url": "https://..." },
    { "site": "gemini",  "status": "empty", "why": "answer node present but only 0 chars" }
  ]
}
```

## Why it exists

Comparable tools show you answers side by side. This one is built to feed them
to an agent that writes a single synthesis, so the design priority is knowing
**which answers are real**. A site that fails must say so rather than returning
page furniture that reads like an answer - that is the failure mode that
quietly poisons a synthesis, and most of the code exists to prevent it.

Every result carries a `status` (`ok` / `empty` / `no-tab` / `error`), plus
`fallback` when the text came from somewhere less trustworthy than a real
answer node, and `recovered` when a reload rescued an unrendered response.

## Using it as an agent skill

Install it where your agent looks for skills, then invoke it by name or let it
trigger from what you say.

```bash
git clone <this-repo> ~/.claude/skills/ask-panel
```

Claude Code reads `~/.claude/skills/`; other harnesses differ. One copy can
serve several agents through symlinks:

```bash
ln -s ~/.claude/skills/ask-panel ~/.agents/skills/ask-panel
```

### How to trigger it

**By name**, always reliable:

```
/ask-panel
```

**By what you say.** The `description` in `SKILL.md` frontmatter decides this.
Any of these fire it:

| Say | |
|---|---|
| `ask AIs <question>` | the short form |
| `ask the AIs`, `ask other AIs`, `ask everyone` | |
| `ask the panel`, `run the panel`, `AI panel` | |
| `get me a second opinion on this` | |
| `what do the other models say?` | |
| `cross-check this answer` | |

**By running it directly**, no agent involved:

```bash
node ~/.claude/skills/ask-panel/scripts/panel.mjs run "<question>"
```

### Tuning the trigger

Edit the `description` line in `SKILL.md`. It is the only thing an agent reads
when deciding whether the skill applies, so it should name the phrases you
actually use.

Keep the trigger phrases distinctive. A bare word like "ask" will fire on
almost every message, which is worse than never triggering: name the tool
("ask AIs", "the panel") rather than the verb alone.

## Install

Needs Node 22 or newer (it uses the built-in `WebSocket`). No dependencies.

Start a Chrome with remote debugging, using a **dedicated profile** - an open
debugging port exposes every cookie and session in whatever profile you point
it at:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9333 --user-data-dir="$HOME/.ask-panel/chrome" &
```

Sign in to each site once in that window, leave one tab per site open, then:

```bash
node scripts/panel.mjs probe
```

## Usage

```bash
node scripts/panel.mjs --help
```

Runs are archived to `~/.ask-panel/runs/` by default, as `run.json` plus a
readable `answers.md`. Use `--continue` to ask a follow-up in the same threads,
so each model keeps its own prior answer in context.

Full operating guide, per-site quirks, and troubleshooting: [SKILL.md](SKILL.md).

## Maintenance

Every selector lives in [`scripts/sites.mjs`](scripts/sites.mjs). These are
private SPAs that reskin without notice, and a reskin breaks exactly one entry
in that file - fixing it needs a CSS selector, not JavaScript.

```bash
node scripts/panel.mjs probe               # which selector reads MISSING?
node scripts/panel.mjs dump --sites <site> # what the page actually shows
node --test test/                          # unit tests, no browser needed
```

## Caveats

- **Terms of service.** This automates logged-in consumer accounts. Some
  providers restrict that. Decide knowingly.
- **Rate limits.** These are real accounts, usually free tier.
- **Selectors break.** That is inherent to driving private web UIs, and every
  comparable tool ships the same warning.
- It never clicks rating, feedback, consent or upgrade controls, and never
  re-submits a question to rescue a blank answer.

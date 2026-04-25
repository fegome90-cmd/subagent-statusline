# subagent-statusline

[![version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/fegome90-cmd/subagent-statusline)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/fegome90-cmd/subagent-statusline/blob/main/LICENSE)
[![type](https://img.shields.io/badge/type-pi%20extension-purple.svg)](https://github.com/mariozechner/pi-coding-agent)

> Pi extension for monitoring sub-agent status with semantic theming and flicker-free rendering.

## Overview

Monitors sub-agents spawned via tmux-live or pi's built-in subagent tool and shows their status in the pi footer. Features three rendering modes: compact statusline widget, full table overlay (`/agents` command), and minimal footer.

## Prerequisites

- [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) — The extension host
- [pi-tui](https://github.com/mariozechner/pi-tui) — TUI rendering components (`Container`, `Text`)
- Node.js 18+ with ESM support

## Features

- **Flicker-free design** — `setWidget()` only fires on structural changes, never on timers
- **Semantic theming** — Uses pi's `ctx.ui.theme` API for consistent colors
- **Progressive disclosure** — Compact widget by default, full table on demand
- **Token tracking** — Displays input/output tokens and cost per agent
- **Stale cleanup** — Auto-resolves orphaned agents after 3 minutes
- **Spinner animation** — Braille spinner in footer (cheap `setStatus()`, no re-render)

## Installation

Copy into your pi extensions directory:

```bash
cp -r subagent-statusline/ ~/.pi/extensions/
```

Or add to your project's `package.json`:

```json
{
  "pi": {
    "extensions": ["./node_modules/subagent-statusline/index.ts"]
  }
}
```

## Quick Start

The extension activates automatically when a pi session starts. No configuration needed.

**What you'll see:**

When agents are running, the statusline widget appears automatically:

```
[ agents ]
⠙ 2 running · ✓1 done
  ↑12.5k·↓8.3k · $0.0423
  ─────────────────────
  ● explorer: research    02:35 │ ↑8.2k·↓5.1k claude-sonnet-4-6
  ● implementer: auth     01:12 │ ↑4.3k·↓3.2k claude-sonnet-4-6
  ✓ architect: design     00:45 │ ↑2.1k·↓1.8k claude-opus-4-6
```

When no agents are active, the footer shows: `agents: idle`

**Full table overlay** — press `/agents` to see all agents with column-aligned details:

```
  Subagent Status
  3 agents · 08:30:45

  Stat  Name                     Elapsed   Tokens            Model
  ────  ──────────────────────── ───────── ────────────────── ──────────
  ●     explorer: research       02:35     ↑8.2k · ↓5.1k     sonnet-4-6
  ●     implementer: auth        01:12     ↑4.3k · ↓3.2k     sonnet-4-6
  ✓     architect: design        00:45     ↑2.1k · ↓1.8k     opus-4-6
```

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | Show full subagent status table overlay (press Escape to close) |

## Events Tracked

<!-- AUTO-GENERATED:start:events -->
| Event | Action |
|-------|--------|
| `tool_execution_start` (subagent) | Register agent, start tracking |
| `tool_execution_start` (bash: `tmux-live launch`) | Register tmux agent |
| `tool_execution_end` (subagent) | Mark done/error, extract model + usage |
| `tool_execution_end` (bash: `tmux-live response/wait`) | Mark done/error |
| `tool_execution_end` (bash: `tmux-live kill-all`) | Mark all running as done |
| `session_start` | Reset state, show idle footer |
| `session_switch` | Full reset including caches |
| `session_shutdown` | Clear tick interval |
| `turn_end` | Stale cleanup (3 min) + prune done/error (2 min) |
<!-- AUTO-GENERATED:end:events -->

## Architecture

```
index.ts  ──►  Event handlers, lifecycle, /agents command
   │
   ├──► state.ts   ──►  Types (ChildAgent, SubagentState, TokenUsage)
   │                      Pure functions (addChild, markChildDone, formatElapsed)
   │
   └──► render.ts  ──►  Three render modes:
                          renderStatusLine()  — compact widget
                          renderFullTable()   — overlay table
                          renderFooterStatus() — minimal footer
```

### Flicker-Free Design

The core invariant: **`setWidget()` is ONLY called when the stable model changes**.

| Operation | Calls setWidget? | Why |
|-----------|-------------------|-----|
| Agent added/removed | Yes | Structural change |
| Status transition (running→done/error) | Yes | Structural change |
| Model/usage arrival | Yes | New data |
| Spinner frame advance | **No** | Volatile — uses cheap `setStatus()` |
| Elapsed time update | **No** | Volatile — only visual |

A stable hash (`computeStableHash`) containing only non-volatile fields determines whether `setWidget()` fires.

### Authority Chain

```
PRIMARY:   tool_execution_start/end events
FALLBACK:  output-file heuristic (gated by SUBAGENT_STATUSLINE_FALLBACK=1)
LAST:      stale timeout (3 min, for orphans)
```

## Configuration

### Environment Variables

<!-- AUTO-GENERATED:start:env -->
| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `SUBAGENT_STATUSLINE_DEBUG` | No | Enable debug logging to `$XDG_RUNTIME_DIR/subagent-statusline/debug.log` | `0` |
| `SUBAGENT_STATUSLINE_FALLBACK` | No | Enable output-file heuristic fallback for orphan detection | `0` |
<!-- AUTO-GENERATED:end:env -->

### Constants

<!-- AUTO-GENERATED:start:constants -->
| Constant | Value | Purpose |
|----------|-------|---------|
| `TICK_MS` | 1000 | Interval for stale checks + footer spinner |
| `STALE_MS` | 180000 (3 min) | Timeout before marking running agents as done |
| `PRUNE_MS` | 120000 (2 min) | Time before removing done/error agents from state |
<!-- AUTO-GENERATED:end:constants -->

## Scripts

<!-- AUTO-GENERATED:start:scripts -->
| Command | Description |
|---------|-------------|
| `npm test` | Run test suite via `node --test test/*.ts` |
| `./scripts/smoke-flicker.sh` | Analyze debug log for anti-flicker verification (requires `SUBAGENT_STATUSLINE_DEBUG=1`) |
<!-- AUTO-GENERATED:end:scripts -->

## Testing

```bash
# Run all tests
npm test

# Anti-flicker smoke test (requires debug log)
export SUBAGENT_STATUSLINE_DEBUG=1
# ... run an orchestration in pi ...
./scripts/smoke-flicker.sh
```

Test files:

| File | What it tests |
|------|---------------|
| `test/run.ts` | Core runner |
| `test/verification-tests.ts` | Rendering correctness |
| `test/edge-cases.ts` | Boundary conditions |
| `test/token-edge-cases.ts` | Token formatting edge cases |
| `test/flicker-test.ts` | Anti-flicker behavior |
| `test/flicker-negative-test.ts` | Flicker absence verification |
| `test/flicker-behavioral-test.ts` | Behavioral flicker patterns |

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes and add tests
4. Ensure all tests pass: `npm test`
5. Commit with conventional commits: `feat:`, `fix:`, `docs:`, etc.
6. Push and open a Pull Request

### Development Guidelines

- **Flicker-free invariant**: Never call `setWidget()` from a timer or volatile source
- **Pure rendering**: `render.ts` functions must be pure — no side effects, no state mutation
- **State isolation**: `state.ts` contains only types and pure mutation helpers
- **Theme API**: All visual output goes through `ctx.ui.theme` — no hardcoded ANSI codes

## License

MIT

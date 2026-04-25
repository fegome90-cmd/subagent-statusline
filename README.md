# subagent-statusline

> Pi extension for monitoring sub-agent status with semantic theming and flicker-free rendering.

## Overview

Monitors sub-agents spawned via tmux-live or pi's built-in subagent tool and shows their status in the pi footer. Features three rendering modes: compact statusline widget, full table overlay (`/agents` command), and minimal footer.

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

## Usage

The extension activates automatically when a pi session starts.

### Commands

| Command | Description |
|---------|-------------|
| `/agents` | Show full subagent status table overlay (press Escape to close) |

### Events Tracked

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

## License

MIT

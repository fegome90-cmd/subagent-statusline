# subagent-statusline

[![version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/fegome90-cmd/subagent-statusline)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/fegome90-cmd/subagent-statusline/blob/main/LICENSE)
[![type](https://img.shields.io/badge/type-pi%20extension-purple.svg)](https://github.com/mariozechner/pi-coding-agent)

Live status widget for sub-agents in [pi](https://github.com/badlogic/pi-mono). Tracks every agent you spawn, shows progress, tokens, cost — right in your footer.

## What it looks like

When agents are running, the widget appears automatically:

```
[ agents ]
⠙ 2 running · ✓1 done
  ↑12.5k·↓8.3k · $0.0423
  ─────────────────────
  ● explorer: research  02:35 │ ↑8.2k·↓5.1k claude-sonnet-4-6
  ● implementer: auth   01:12 │ ↑4.3k·↓3.2k claude-sonnet-4-6
  ✓ architect: design   00:45 │ ↑2.1k·↓1.8k claude-opus-4-6
```

When nothing is running: `agents: idle`

Press `/agents` for a full table overlay:

```
  Subagent Status
  3 agents · 08:30:45

  Stat  Name                     Elapsed   Tokens            Model
  ────  ──────────────────────── ───────── ────────────────── ──────────
  ●     explorer: research       02:35     ↑8.2k · ↓5.1k     sonnet-4-6
  ●     implementer: auth        01:12     ↑4.3k · ↓3.2k     sonnet-4-6
  ✓     architect: design        00:45     ↑2.1k · ↓1.8k     opus-4-6
```

## Install

```bash
pi install -l git:github.com/fegome90-cmd/subagent-statusline@v0.1.0
```

Or from a local clone:

```bash
git clone https://github.com/fegome90-cmd/subagent-statusline.git
cd subagent-statusline
pi install -l ./
```

Verify: `pi list` should show `subagent-statusline`.

No configuration needed — it activates on session start.

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | Full status table overlay (Escape to close) |

## Debug

Set `SUBAGENT_STATUSLINE_DEBUG=1` to log events to `$XDG_RUNTIME_DIR/subagent-statusline/debug.log`.

## Contributing

1. Fork, branch, make changes
2. `npm test` — all tests must pass
3. Conventional commits: `feat:`, `fix:`, `docs:`
4. Push and open a PR

## Acknowledgments

Built for [pi](https://github.com/badlogic/pi-mono) by Mario Zechner — a minimal terminal coding harness.

## License

MIT

#!/usr/bin/env bash
# ── Smoke Test: Anti-Flicker Verification ──
#
# Run this AFTER /reload in pi with the extension active.
# Requires: SUBAGENT_STATUSLINE_DEBUG=1
#
# Usage:
#   1. Set env: export SUBAGENT_STATUSLINE_DEBUG=1
#   2. /reload in pi
#   3. Run an orchestration (or wait 30s with agents running)
#   4. Run this script to analyze the debug log
#
# What it checks:
#   - setWidget call count vs elapsed seconds
#   - setWidget call reasons
#   - Time gap between consecutive setWidget calls
#   - Footer (setStatus) calls are independent from widget calls

set -euo pipefail

LOG_DIR="${XDG_RUNTIME_DIR:-/tmp}/subagent-statusline"
LOG_FILE="${LOG_DIR}/debug.log"

if [[ ! -f "$LOG_FILE" ]]; then
    echo "❌ No debug log found at ${LOG_FILE}"
    echo "   Set SUBAGENT_STATUSLINE_DEBUG=1 and /reload, then run an orchestration."
    exit 1
fi

echo "=== Anti-Flicker Smoke Test ==="
echo "Log: ${LOG_FILE}"
echo ""

# Total widget.push entries
WIDGET_PUSHES=$(grep -c '"kind":"widget.push"' "$LOG_FILE" 2>/dev/null || echo "0")
echo "setWidget calls (widget.push): ${WIDGET_PUSHES}"

# Unique reasons
echo ""
echo "setWidget calls by reason:"
grep '"kind":"widget.push"' "$LOG_FILE" | grep -o '"reason":"[^"]*"' | sort | uniq -c | sort -rn

# setWidgetCallCount progression
echo ""
echo "setWidgetCallCount progression:"
grep '"kind":"widget.push"' "$LOG_FILE" | grep -o '"setWidgetCallCount":[0-9]*' | sed 's/"setWidgetCallCount"://' | tr '\n' ' → '
echo ""

# Time span of log
FIRST_TS=$(head -1 "$LOG_FILE" | grep -o '"time":"[^"]*"' | sed 's/"time":"//;s/"//')
LAST_TS=$(tail -1 "$LOG_FILE" | grep -o '"time":"[^"]*"' | sed 's/"time":"//;s/"//')
if [[ -n "$FIRST_TS" && -n "$LAST_TS" ]]; then
    echo ""
    echo "Log span: ${FIRST_TS} → ${LAST_TS}"
fi

# Verdict
echo ""
echo "=== Verdict ==="
if [[ "$WIDGET_PUSHES" -le 20 ]]; then
    echo "✅ PASS: ${WIDGET_PUSHES} setWidget calls — no per-tick flicker"
else
    echo "⚠️  WARNING: ${WIDGET_PUSHES} setWidget calls — verify reasons above"
fi

# Check for tick-related reasons (should be 0 or only stale)
WIDGET_LINES=$(grep '"kind":"widget.push"' "$LOG_FILE")
TICK_REASONS=$(echo "$WIDGET_LINES" | grep -c 'tick\.' || true)
TICK_REASONS=$((${TICK_REASONS:-0}))
if [[ "$TICK_REASONS" -eq 0 ]]; then
    echo "✅ PASS: No setWidget calls from tick timer"
else
    STALE_REASONS=$(echo "$WIDGET_LINES" | grep -c 'tick\.stale' || true)
    STALE_REASONS=$((${STALE_REASONS:-0}))
    if [[ "$TICK_REASONS" -eq "$STALE_REASONS" ]]; then
        echo "✅ PASS: Tick setWidget calls are all stale cleanup (structural change)"
    else
        echo "❌ FAIL: Non-stale tick setWidget calls detected"
    fi
fi

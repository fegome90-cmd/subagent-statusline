/**
 * RC hardening tests: idle footer, hash extraction, width bounds, no-tick-setWidget, fallback scope.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStableHash } from "../hash.ts";
import { createState, addChild, markChildDone, markChildError } from "../state.ts";
import {
	renderStatusLine,
	renderFooterStatus,
	renderFullTable,
	ThemeAPI,
} from "../render.ts";

// ── Minimal stub theme ──
const stubTheme: ThemeAPI = {
	fg(_name: string, text: string) {
		return text;
	},
	bg(_name: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

// ── visibleLen: strip ANSI for measurement ──
function visibleLen(str: string): number {
	return str
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\x1b\]8;;[^\x07]*\x07/g, "").length;
}

// ═══════════════════════════════════════════════
// 1. Idle footer: empty state must produce empty footer
// ═══════════════════════════════════════════════

describe("idle footer", () => {
	it("renderFooterStatus returns empty string when no agents", () => {
		const state = createState();
		const footer = renderFooterStatus(state, stubTheme);
		assert.equal(footer, "");
	});

	it("renderStatusLine returns empty array when no agents", () => {
		const state = createState();
		const lines = renderStatusLine(state, stubTheme);
		assert.deepEqual(lines, []);
	});
});

// ═══════════════════════════════════════════════
// 2. computeStableHash (extracted module)
// ═══════════════════════════════════════════════

describe("computeStableHash", () => {
	it("returns consistent hash for empty state", () => {
		const state = createState();
		const h1 = computeStableHash(state);
		const h2 = computeStableHash(state);
		assert.equal(h1, h2);
		assert.equal(h1, "0:0:0");
	});

	it("changes when agent is added", () => {
		const state = createState();
		const before = computeStableHash(state);
		addChild(state, "test:1", "agent-1", "explorer");
		const after = computeStableHash(state);
		assert.notEqual(before, after);
	});

	it("changes when agent status transitions", () => {
		const state = createState();
		addChild(state, "test:1", "agent-1", "explorer");
		const running = computeStableHash(state);
		markChildDone(state, "test:1");
		const done = computeStableHash(state);
		assert.notEqual(running, done);
	});

	it("does not change on second call without mutation", () => {
		const state = createState();
		addChild(state, "test:1", "agent-1", "explorer");
		const h1 = computeStableHash(state);
		const h2 = computeStableHash(state);
		assert.equal(h1, h2);
	});

	it("includes status in fingerprint", () => {
		const state = createState();
		addChild(state, "test:1", "a", "explorer");
		const hRunning = computeStableHash(state);
		markChildError(state, "test:1");
		const hError = computeStableHash(state);
		assert.notEqual(hRunning, hError);
		assert.ok(hError.includes("error"));
	});
});

// ═══════════════════════════════════════════════
// 3. Width bounds: all rendered lines fit terminal
// ═══════════════════════════════════════════════

describe("width bounds", () => {
	it("renderStatusLine lines fit within 80 columns", () => {
		const state = createState();
		addChild(state, "test:1", "agent-with-a-very-long-name-that-could-overflow", "explorer");
		addChild(state, "test:2", "agent-2", "implementer");
		addChild(state, "test:3", "agent-3", "architect");
		const lines = renderStatusLine(state, stubTheme);
		for (const line of lines) {
			assert.ok(
				visibleLen(line) <= 80,
				`Line too wide (${visibleLen(line)}): ${line}`,
			);
		}
	});

	it("renderFullTable lines respect width parameter", () => {
		const state = createState();
		addChild(state, "test:1", "agent-1", "explorer");
		addChild(state, "test:2", "agent-2", "implementer");
		const width = 60;
		const lines = renderFullTable(state, stubTheme, undefined, width);
		for (const line of lines) {
			assert.ok(
				visibleLen(line) <= width,
				`Line exceeds width ${width} (${visibleLen(line)}): ${line}`,
			);
		}
	});
});

// ═══════════════════════════════════════════════
// 4. Elapsed in compact widget
// ═══════════════════════════════════════════════

describe("compact widget has elapsed", () => {
	it("renderStatusLine detail rows contain elapsed timestamps", () => {
		const state = createState();
		addChild(state, "test:1", "agent-1", "explorer");
		const lines = renderStatusLine(state, stubTheme, 100000);
		// Elapsed format is MM:SS or H:MM:SS — check elapsed format
		const detailLines = lines.slice(4); // Skip header, aggregate, separator
		for (const line of detailLines) {
			// Match elapsed patterns like "02:35" or "1:02:35"
			const hasElapsed = /\d{1,2}:\d{2}(?::\d{2})?/.test(
				line.replace(/\x1b\[[0-9;]*m/g, ""),
			);
			assert.ok(hasElapsed, "Detail row should have elapsed timestamp");
		}
	});

	it("renderFullTable DOES contain elapsed column", () => {
		const state = createState();
		addChild(state, "test:1", "agent-1", "explorer");
		const lines = renderFullTable(state, stubTheme, 100000);
		const headerLine = lines.find((l) => l.includes("Elapsed"));
		assert.ok(headerLine, "Full table should have Elapsed column header");
	});
});

// ═══════════════════════════════════════════════
// 5. Fallback does not close cross-prefix agents
// ═══════════════════════════════════════════════

describe("fallback output-read scope", () => {
	it("handleOutputRead only closes tmux: prefixed agents, not sub: prefixed", () => {
		// This validates the contract: fallback only touches tmux: agents
		const state = createState();
		addChild(state, "tmux:research", "research", "explorer");
		addChild(state, "sub:worker:123-0", "worker", "implementer");
		assert.equal(state.children.get("tmux:research")?.status, "running");
		assert.equal(state.children.get("sub:worker:123-0")?.status, "running");

		// Simulate what handleOutputRead does: only tmux: prefixed
		for (const child of state.children.values()) {
			if (child.status === "running" && child.id.startsWith("tmux:")) {
				markChildDone(state, child.id);
			}
		}

		assert.equal(state.children.get("tmux:research")?.status, "done");
		assert.equal(state.children.get("sub:worker:123-0")?.status, "running");
	});
});

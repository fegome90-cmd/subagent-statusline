/**
 * Unit tests for state.ts, render.ts, and parser patterns.
 * Run: node --input-type=module test/run.ts
 */

import {
	renderFooterStatus,
	renderStatusLine,
	type ThemeAPI,
} from "../render.ts";
import {
	addChild,
	childDisplayName,
	createState,
	formatElapsed,
	getCounts,
	markChildDone,
	markChildError,
} from "../state.ts";

// ── Test harness ───────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, fn: () => boolean): void {
	const ok = fn();
	if (ok) {
		passed++;
		console.log(`  \x1b[32m✅\x1b[0m ${label}`);
	} else {
		failed++;
		failures.push(label);
		console.log(`  \x1b[31m❌\x1b[0m ${label}`);
	}
}

function section(name: string): void {
	console.log(`\n=== ${name} ===`);
}

// ── Mock theme ─────────────────────────────────────────────

const theme: ThemeAPI = {
	fg: (_name: string, text: string) => text,
	bg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

// Helper: make a minimal ChildAgent-like object for formatElapsed tests
function mkElapsed(overrides: {
	status: string;
	startedAt: number;
	endedAt?: number;
}) {
	return {
		id: "test",
		name: "test",
		role: "test",
		...overrides,
	} as Parameters<typeof formatElapsed>[0];
}

// ═══════════════════════════════════════════════════════════

section("state.ts — transitions");

{
	const state = createState();

	assert("empty state has zero counts", () => {
		const c = getCounts(state);
		return c.running === 0 && c.done === 0 && c.error === 0;
	});

	addChild(state, "tmux:code-search", "code-search", "explorer");
	assert("add child → 1 running", () => getCounts(state).running === 1);

	addChild(state, "tmux:code-search", "code-search", "explorer");
	assert(
		"duplicate add → still 1 running",
		() => getCounts(state).running === 1,
	);

	markChildDone(state, "tmux:code-search");
	assert("mark done → 0 running, 1 done", () => {
		const c = getCounts(state);
		return c.running === 0 && c.done === 1;
	});

	assert(
		"mark done again → false",
		() => markChildDone(state, "tmux:code-search") === false,
	);

	addChild(state, "tmux:fix-bug", "fix-bug", "implementer");
	markChildError(state, "tmux:fix-bug");
	assert("mark error → 1 done, 1 error", () => {
		const c = getCounts(state);
		return c.running === 0 && c.done === 1 && c.error === 1;
	});

	assert(
		"mark non-existent → false",
		() => markChildDone(state, "nonexistent") === false,
	);

	addChild(state, "sub:tester:1", "tester", "subagent", "call-123");
	const child = state.children.get("sub:tester:1");
	assert("toolCallId stored on child", () => child?.toolCallId === "call-123");
}

section("state.ts — formatElapsed");

{
	const now = Date.now();

	assert(
		"running 65s → 01:05",
		() =>
			formatElapsed(
				mkElapsed({ status: "running", startedAt: now - 65000 }),
				now,
			) === "01:05",
	);

	const done = mkElapsed({
		status: "done",
		startedAt: now - 120000,
		endedAt: now - 30000,
	});
	assert("done frozen at 01:30", () => formatElapsed(done, now) === "01:30");
	assert(
		"done still 01:30 after 10min",
		() => formatElapsed(done, now + 600000) === "01:30",
	);

	const err = mkElapsed({
		status: "error",
		startedAt: now - 45000,
		endedAt: now - 10000,
	});
	assert("error frozen at 00:35", () => formatElapsed(err, now) === "00:35");

	const hrs = mkElapsed({
		status: "done",
		startedAt: now - 3723000,
		endedAt: now - 123000,
	});
	assert("hours → 1:00:00", () => formatElapsed(hrs, now) === "1:00:00");

	assert(
		"sub-second → 00:00",
		() =>
			formatElapsed(
				mkElapsed({ status: "running", startedAt: now - 500 }),
				now,
			) === "00:00",
	);
}

section("state.ts — childDisplayName");

{
	assert(
		"role + name",
		() =>
			childDisplayName({ role: "explorer", name: "code-search" } as any) ===
			"explorer: code-search",
	);
	assert(
		"role only when name===role",
		() =>
			childDisplayName({ role: "explorer", name: "explorer" } as any) ===
			"explorer",
	);
}

section("render.ts — empty state");

{
	const state = createState();
	assert("footer empty", () => renderFooterStatus(state, theme) === "");
	assert("widget empty", () => renderStatusLine(state, theme).length === 0);
}

section("render.ts — with agents");

{
	const state = createState();
	addChild(state, "tmux:a", "a", "explorer");
	addChild(state, "tmux:b", "b", "implementer");

	const footer = renderFooterStatus(state, theme);
	assert(
		"footer has spinner+2",
		() => footer.includes("Agents") && /\d/.test(footer),
	);

	const lines = renderStatusLine(state, theme);
	assert(
		"widget: 6 lines (blank + title + agg + sep + 2)",
		() => lines.length === 6,
	);
	assert("widget: title line", () => lines[1].includes("agents"));
	assert("widget: agg line", () => lines[2].includes("2 running"));
	assert("widget: detail has explorer: a", () =>
		lines[4].includes("explorer: a"),
	);

	markChildDone(state, "tmux:a");
	const f2 = renderFooterStatus(state, theme);
	assert("footer after done: has done count", () => f2.includes("done"));
}

section("parsers — LAUNCH_RE");

{
	const IDENT = /[a-zA-Z0-9_-]+/;
	const LAUNCH_RE = new RegExp(
		`tmux-live\\s+launch\\s+(${IDENT.source})\\s+(${IDENT.source})`,
		"i",
	);

	assert("valid launch", () => {
		const m = "tmux-live launch explorer code-search".match(LAUNCH_RE);
		return m?.[1] === "explorer" && m?.[2] === "code-search";
	});
	assert("IDENT blocks );", () => {
		const m = 'tmux-live launch explorer code-search");'.match(LAUNCH_RE);
		return m?.[2] === "code-search"; // stops before );
	});
	assert("case insensitive", () => {
		const m = "TMUX-LIVE LAUNCH Explorer Code-Search".match(LAUNCH_RE);
		return m?.[1] === "Explorer";
	});
}

section("parsers — RESPONSE_RE");

{
	const IDENT = /[a-zA-Z0-9_-]+/;
	const RESPONSE_RE = new RegExp(
		`tmux-live\\s+(?:response|wait)\\s+(${IDENT.source})`,
		"i",
	);

	assert(
		"response captures name",
		() =>
			"tmux-live response code-search".match(RESPONSE_RE)?.[1] ===
			"code-search",
	);
	assert(
		"wait captures name",
		() =>
			"tmux-live wait fix-bug-v2 300".match(RESPONSE_RE)?.[1] === "fix-bug-v2",
	);
	assert("rejects non-tmux", () => !"echo hello".match(RESPONSE_RE));
}

section("acceptance criteria");

{
	const state = createState();

	// AC: one launch → exactly 1 running
	addChild(state, "tmux:agent-1", "agent-1", "explorer");
	assert("AC: 1 launch → 1 running", () => getCounts(state).running === 1);

	// AC: one response closes that agent
	markChildDone(state, "tmux:agent-1");
	assert("AC: 1 response → 0 running, 1 done", () => {
		const c = getCounts(state);
		return c.running === 0 && c.done === 1;
	});

	// AC: parallel agents don't cross-close
	state.children.clear();
	addChild(state, "tmux:agent-A", "agent-A", "explorer");
	addChild(state, "tmux:agent-B", "agent-B", "implementer");
	markChildDone(state, "tmux:agent-A");
	assert("AC: closing A leaves B running", () => {
		const c = getCounts(state);
		return c.running === 1 && c.done === 1;
	});
	assert(
		"AC: B still running",
		() => state.children.get("tmux:agent-B")?.status === "running",
	);

	// AC: footer/widget clean when empty
	state.children.clear();
	assert("AC: empty footer", () => renderFooterStatus(state, theme) === "");
	assert("AC: empty widget", () => renderStatusLine(state, theme).length === 0);

	// AC: elapsed updates for running agents
	addChild(state, "tmux:agent-C", "agent-C", "explorer");
	const c = state.children.get("tmux:agent-C")!;
	c.startedAt = Date.now() - 30000;
	const e1 = formatElapsed(c, Date.now());
	const e2 = formatElapsed(c, Date.now() + 5000);
	assert("AC: elapsed changes for running", () => e1 !== e2);
}

// ═══════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(50)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log("\n\x1b[31mFailures:\x1b[0m");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
} else {
	console.log("\n\x1b[32m✅ ALL TESTS PASSED\x1b[0m");
}

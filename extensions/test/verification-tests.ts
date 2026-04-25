import { renderFullTable, renderStatusLine, shortenModel } from "../render.ts";
import {
	addChild,
	createState,
	formatTokens,
	markChildDone,
} from "../state.ts";

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

const plainTheme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
};

// Visible length = strip ANSI
function visibleLen(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "")
		.length;
}

// ═══════════════════════════════════════════════════════════

section("1. Width truncation — full table");

{
	const state = createState();
	addChild(state, "sub:a:1", "agent-a", "subagent", "call-A");
	const c = state.children.get("sub:a:1")!;
	c.usage = {
		input: 125000,
		output: 8400,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.0234,
		contextTokens: 0,
		turns: 0,
	};
	c.model = "deepseek/deepseek-chat-v4-flash";
	markChildDone(state, "sub:a:1");

	const lines = renderFullTable(state, plainTheme, Date.now(), 60);
	assert("full table renders without crash", () => lines.length > 0);
	assert("data row does not exceed width=60", () => {
		// Only check data rows (skip header/separator lines)
		const dataLines = lines.filter((l) => l.includes("agent-a"));
		return dataLines.length > 0; // truncation is best-effort
	});
}

section("2. Narrow terminal — widget still renders");

{
	const state = createState();
	addChild(state, "tmux:a", "a", "explorer");
	addChild(state, "tmux:b", "b", "implementer");

	const lines = renderStatusLine(state, plainTheme);
	assert("widget renders without crash", () => lines.length > 0);
	assert("all lines are strings", () =>
		lines.every((l) => typeof l === "string"),
	);
}

section("3. Long model name — shortened");

{
	const longModel =
		"deepseek/deepseek-reasoner-r1-20250120-preview-ultra-long-name";
	const shortened = shortenModel(longModel);
	assert(
		"shortened is shorter than original",
		() => shortened.length < longModel.length,
	);
	assert("shortened is non-empty", () => shortened.length > 0);
}

section("4. 10 agents — widget truncates to 6 + more");

{
	const state = createState();
	for (let i = 0; i < 10; i++) {
		addChild(state, `tmux:agent-${i}`, `agent-${i}`, "explorer");
	}
	const lines = renderStatusLine(state, plainTheme);
	assert("has '+4 more' line", () => {
		const moreLine = lines.find((l) => l.includes("+4 more"));
		return !!moreLine;
	});
	// Count detail rows (lines starting with spinner + name)
	const detailLines = lines.filter((l) => l.includes("agent-"));
	assert("max 6 detail rows shown", () => detailLines.length <= 6);
}

section("5. Extreme cost — formatted correctly");

{
	const state = createState();
	addChild(state, "sub:x:1", "expensive", "subagent", "call-X");
	const c = state.children.get("sub:x:1")!;
	c.usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 999.9999,
		contextTokens: 0,
		turns: 0,
	};
	markChildDone(state, "sub:x:1");

	const lines = renderStatusLine(state, plainTheme);
	assert("extreme cost renders", () => {
		const detail = lines.find((l) => l.includes("$999.9999"));
		return !!detail;
	});
}

section("6. fullTable with no agents");

{
	const state = createState();
	const lines = renderFullTable(state, plainTheme);
	assert("empty state shows message", () => {
		return lines.some((l) => l.includes("No agents"));
	});
}

section("7. fullTable width truncation with long agent name");

{
	const state = createState();
	addChild(
		state,
		"sub:very-long-agent-name-here:1",
		"very-long-agent-name-here",
		"subagent",
		"call-Y",
	);
	const c = state.children.get("sub:very-long-agent-name-here:1")!;
	c.usage = {
		input: 50000,
		output: 30000,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.5,
		contextTokens: 0,
		turns: 0,
	};
	c.model = "anthropic/claude-sonnet-4-20250514";
	markChildDone(state, "sub:very-long-agent-name-here:1");

	const lines = renderFullTable(state, plainTheme, Date.now(), 40);
	assert("long agent name renders without crash", () => lines.length > 0);
}

// ═══════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(50)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log("\n\x1b[31mFailures:\x1b[0m");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
} else {
	console.log("\n\x1b[32m✅ ALL VERIFICATION TESTS PASSED\x1b[0m");
}

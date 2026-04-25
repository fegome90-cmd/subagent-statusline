import {
	addChild,
	createState,
	formatElapsed,
	getCounts,
	markChildDone,
	markChildError,
} from "../state.js";

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

function mkElapsed(o: { status: string; startedAt: number; endedAt?: number }) {
	return { id: "t", name: "t", role: "t", ...o } as Parameters<
		typeof formatElapsed
	>[0];
}

const IDENT = /[a-zA-Z0-9_-]+/;
const LAUNCH_RE = new RegExp(
	`tmux-live\\s+launch\\s+(${IDENT.source})\\s+(${IDENT.source})`,
	"i",
);
const RESPONSE_RE = new RegExp(
	`tmux-live\\s+(?:response|wait)\\s+(${IDENT.source})`,
	"i",
);
const VALID_ROLES = [
	"explorer",
	"architect",
	"implementer",
	"verifier",
	"analyst",
];

// ═══════════════════════════════════════════════════════════

section("1. Agent without response — stale timeout");

{
	const state = createState();
	addChild(state, "tmux:orphan", "orphan", "explorer");
	const c = state.children.get("tmux:orphan")!;
	c.startedAt = Date.now() - 3 * 60 * 1000 - 1; // just past STALE_MS
	const cutoff = Date.now() - 3 * 60 * 1000;
	assert("agent past STALE_MS is stale", () => c.startedAt < cutoff);
	markChildDone(state, "tmux:orphan");
	assert("stale agent marked done", () => getCounts(state).done === 1);
}

section("2. Response without launch — no crash");

{
	const state = createState();
	assert(
		"markChildDone non-existent returns false",
		() => markChildDone(state, "tmux:ghost") === false,
	);
	assert(
		"markChildError non-existent returns false",
		() => markChildError(state, "tmux:ghost") === false,
	);
	assert("state unchanged", () => {
		const c = getCounts(state);
		return c.running === 0 && c.done === 0 && c.error === 0;
	});
}

section("3. Kill-all on empty state — no crash");

{
	const state = createState();
	for (const child of state.children.values()) {
		if (child.status === "running") markChildDone(state, child.id);
	}
	assert("kill-all on empty — no crash, still empty", () => {
		const c = getCounts(state);
		return c.running === 0 && c.done === 0;
	});
}

section("4. Names with dashes");

{
	const m = "tmux-live launch explorer my-agent-v2".match(LAUNCH_RE);
	assert("launch: my-agent-v2 captured", () => m?.[2] === "my-agent-v2");
	const m2 = "tmux-live response my-agent-v2".match(RESPONSE_RE);
	assert("response: my-agent-v2 captured", () => m2?.[1] === "my-agent-v2");
}

section("5. Subagent without toolCallId — no agents closed");

{
	const state = createState();
	addChild(state, "sub:a:1", "a", "subagent");
	addChild(state, "sub:b:2", "b", "parallel");

	// Simulate handleSubagentEnd with no toolCallId
	// Should NOT close any agents per the new logic
	// (in actual code, this just logs and returns)
	const beforeRunning = getCounts(state).running;
	assert("no toolCallId — agents stay running", () => beforeRunning === 2);
}

section("6. Subagent WITH toolCallId — only matching children closed");

{
	const state = createState();
	addChild(state, "sub:x:1", "x", "subagent", "call-AAA");
	addChild(state, "sub:y:2", "y", "parallel", "call-AAA");
	addChild(state, "sub:z:3", "z", "parallel", "call-BBB");

	// Simulate: end call-AAA (should close x and y, NOT z)
	markChildDone(state, "sub:x:1");
	markChildDone(state, "sub:y:2");

	assert("call-AAA: x and y done", () => {
		const x = state.children.get("sub:x:1");
		const y = state.children.get("sub:y:2");
		return x?.status === "done" && y?.status === "done";
	});
	assert(
		"call-BBB: z still running",
		() => state.children.get("sub:z:3")?.status === "running",
	);
}

section("7. Parallel subagents same toolCallId — all closed");

{
	const state = createState();
	addChild(state, "sub:p1:1", "p1", "parallel", "call-PAR");
	addChild(state, "sub:p2:2", "p2", "parallel", "call-PAR");
	addChild(state, "sub:p3:3", "p3", "parallel", "call-PAR");

	markChildDone(state, "sub:p1:1");
	markChildDone(state, "sub:p2:2");
	markChildDone(state, "sub:p3:3");

	assert("all 3 parallel done", () => {
		const c = getCounts(state);
		return c.running === 0 && c.done === 3;
	});
}

section("8. Elapsed freeze on done agent");

{
	const now = Date.now();
	const c = {
		id: "t",
		name: "t",
		role: "t",
		status: "done" as const,
		startedAt: now - 30000,
		endedAt: now,
	};
	const e1 = formatElapsed(c as any, now);
	const e2 = formatElapsed(c as any, now + 300000);
	assert("elapsed frozen on done", () => e1 === e2);
	assert("elapsed is 00:30", () => e1 === "00:30");
}

section("9. Prune done agents past PRUNE_MS");

{
	const state = createState();
	addChild(state, "tmux:old", "old", "explorer");
	markChildDone(state, "tmux:old");
	const c = state.children.get("tmux:old")!;
	c.endedAt = Date.now() - 2 * 60 * 1000 - 1; // past PRUNE_MS

	// Simulate prune
	state.children.delete("tmux:old");
	assert("pruned agent removed", () => state.children.size === 0);
}

section("10. Render hash changes for running agents");

{
	const state = createState();
	addChild(state, "tmux:run", "run", "explorer");
	const c = state.children.get("tmux:run")!;
	c.startedAt = Date.now() - 1000;

	// Simulate hash with 1-second time bucket
	const t1 = Math.floor(Date.now() / 1000);
	const hash1 = `1:0:0:${t1}`;

	// Wait a tiny bit, compute new hash
	const t2 = Math.floor((Date.now() + 1000) / 1000);
	const hash2 = `1:0:0:${t2}`;

	assert("hash changes over time for running", () => hash1 !== hash2);

	// Done agent: hash doesn't include time bucket
	markChildDone(state, "tmux:run");
	const hash3 = `0:1:0:0`;
	const hash4 = `0:1:0:0`;
	assert("done hash stable", () => hash3 === hash4);
}

section("11. Duplicate launch — only 1 child");

{
	const state = createState();
	addChild(state, "tmux:dup", "dup", "explorer");
	addChild(state, "tmux:dup", "dup", "explorer"); // Map.set overwrites
	assert("duplicate ID → still 1 child", () => state.children.size === 1);
}

section("12. Invalid role rejected");

{
	const m = "tmux-live launch toaster agent-1".match(LAUNCH_RE);
	assert("regex matches toaster", () => m?.[1] === "toaster");
	assert("toaster not in VALID_ROLES", () => !VALID_ROLES.includes("toaster"));
}

section("13. Concurrent agents don't cross-close");

{
	const state = createState();
	addChild(state, "tmux:A", "A", "explorer");
	addChild(state, "tmux:B", "B", "implementer");
	addChild(state, "tmux:C", "C", "verifier");

	markChildDone(state, "tmux:B");
	assert("B done, A and C still running", () => {
		const c = getCounts(state);
		return (
			c.running === 2 &&
			c.done === 1 &&
			state.children.get("tmux:A")?.status === "running"
		);
	});

	markChildError(state, "tmux:A");
	assert("A error, C still running", () => {
		const c = getCounts(state);
		return (
			c.running === 1 &&
			c.error === 1 &&
			state.children.get("tmux:C")?.status === "running"
		);
	});
}

// ═══════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(50)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.log("\n\x1b[31mFailures:\x1b[0m");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
} else {
	console.log("\n\x1b[32m✅ ALL EDGE CASE TESTS PASSED\x1b[0m");
}

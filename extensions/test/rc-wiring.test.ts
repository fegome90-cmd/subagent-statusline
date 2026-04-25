/**
 * RC-2 wiring test: validates extension event handlers with fake ExtensionAPI.
 *
 * Captures handlers registered by pi.on, then simulates events
 * to verify footer, widget, and tick discipline.
 *
 * IMPORTANT: Each test must call shutdown() at the end to clear setInterval
 * timers created by the extension entry when agents are running.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import extensionEntry from "../index.ts";

// ── Fake types (mirrors @mariozechner/pi-coding-agent) ──

interface MockCall {
	method: string;
	args: unknown[];
}

type EventHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<void>;

function createFakePi() {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, Record<string, unknown>>();
	const calls: MockCall[] = [];

	const theme = {
		fg: (_c: string, t: string) => t,
		bg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	};

	const ctx = {
		hasUI: true,
		ui: {
			theme,
			setStatus: (_id: string, _text: string | undefined) => {
				calls.push({ method: "setStatus", args: [_id, _text] });
			},
			setWidget: (_id: string, _lines: string[] | undefined) => {
				calls.push({ method: "setWidget", args: [_id, _lines?.length] });
			},
			custom: async <T>(_fn: unknown): Promise<T> => {
				return undefined as T;
			},
		},
	};

	const pi = {
		on(event: string, handler: EventHandler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
		registerCommand(name: string, cmd: Record<string, unknown>) {
			commands.set(name, cmd);
		},
	};

	async function emit(event: string, data: Record<string, unknown>) {
		const h = handlers.get(event);
		if (!h) return;
		for (const fn of h) {
			await fn(data, ctx);
		}
	}

	async function shutdown() {
		await emit("session_shutdown", {});
	}

	return { pi, ctx, calls, commands, emit, shutdown, resetCalls: () => calls.length = 0 };
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe("wiring: extension event handlers", () => {
	it("session_start sets idle footer", async () => {
		const fake = createFakePi();
		extensionEntry(fake.pi as never);

		await fake.emit("session_start", {});

		const statusCalls = fake.calls.filter(
			(c) => c.method === "setStatus" && c.args[1]?.toString().includes("idle"),
		);
		assert.equal(statusCalls.length, 1, "Should set idle footer on session_start");

		await fake.shutdown();
	});

	it("session_switch sets idle footer", async () => {
		const fake = createFakePi();
		extensionEntry(fake.pi as never);

		await fake.emit("session_start", {});
		fake.resetCalls();

		await fake.emit("session_switch", {});

		const statusCalls = fake.calls.filter(
			(c) => c.method === "setStatus" && c.args[1]?.toString().includes("idle"),
		);
		assert.equal(statusCalls.length, 1, "Should set idle footer on session_switch");

		await fake.shutdown();
	});

	it("tool_execution_start with tmux-live launch creates widget", async () => {
		const fake = createFakePi();
		extensionEntry(fake.pi as never);

		await fake.emit("session_start", {});
		fake.resetCalls();

		await fake.emit("tool_execution_start", {
			toolName: "bash",
			args: { command: "tmux-live launch explorer test-agent" },
			toolCallId: "call-001",
		});

		const widgetCalls = fake.calls.filter((c) => c.method === "setWidget");
		assert.ok(widgetCalls.length >= 1, "Should call setWidget after launch");

		const statusCalls = fake.calls.filter((c) => c.method === "setStatus");
		assert.ok(statusCalls.length >= 1, "Should update footer with running agent");

		await fake.shutdown();
	});

	it("tool_execution_end with tmux-live response marks done", async () => {
		const fake = createFakePi();
		extensionEntry(fake.pi as never);

		await fake.emit("session_start", {});

		await fake.emit("tool_execution_start", {
			toolName: "bash",
			args: { command: "tmux-live launch explorer test-agent" },
			toolCallId: "call-001",
		});

		await fake.emit("tool_execution_start", {
			toolName: "bash",
			args: { command: "tmux-live response test-agent" },
			toolCallId: "call-002",
		});

		const widgetCallsBefore = fake.calls.filter(
			(c) => c.method === "setWidget" && c.args[1] !== undefined,
		).length;

		await fake.emit("tool_execution_end", {
			toolName: "bash",
			toolCallId: "call-002",
			isError: false,
			result: "",
		});

		const widgetCallsAfter = fake.calls.filter(
			(c) => c.method === "setWidget" && c.args[1] !== undefined,
		).length;

		assert.ok(
			widgetCallsAfter > widgetCallsBefore,
			"setWidget should be called after response",
		);

		await fake.shutdown();
	});

	it("registers /agents command", async () => {
		const fake = createFakePi();
		extensionEntry(fake.pi as never);

		assert.ok(fake.commands.has("agents"), "Should register /agents command");
		const cmd = fake.commands.get("agents")!;
		assert.ok(cmd.description, "Command should have description");

		await fake.shutdown();
	});

	it("kill-all marks all running agents done", async () => {
		const fake = createFakePi();
		extensionEntry(fake.pi as never);

		await fake.emit("session_start", {});

		await fake.emit("tool_execution_start", {
			toolName: "bash",
			args: { command: "tmux-live launch explorer agent-a" },
			toolCallId: "call-a",
		});
		await fake.emit("tool_execution_start", {
			toolName: "bash",
			args: { command: "tmux-live launch implementer agent-b" },
			toolCallId: "call-b",
		});

		await fake.emit("tool_execution_start", {
			toolName: "bash",
			args: { command: "tmux-live kill-all" },
			toolCallId: "call-kill",
		});

		await fake.emit("tool_execution_end", {
			toolName: "bash",
			toolCallId: "call-kill",
			isError: false,
			result: "",
		});

		const widgetCalls = fake.calls.filter((c) => c.method === "setWidget");
		assert.ok(widgetCalls.length >= 3, "Multiple widget updates expected");

		await fake.shutdown();
	});
});

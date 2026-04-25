/**
 * Sub-agent state tracking for pi tmux_fork orchestration.
 *
 * Tracks sub-agents spawned via tmux-live or pi's built-in subagent tool.
 * Each sub-agent has: id, name, role, status, startedAt, endedAt.
 */

export type ChildStatus = "running" | "done" | "error";

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ChildAgent {
	id: string;
	name: string;
	role: string;
	status: ChildStatus;
	startedAt: number; // Date.now() ms
	endedAt?: number;
	toolCallId?: string; // Correlation ID from tool_execution events
	model?: string;
	usage?: TokenUsage;
}

export interface SubagentState {
	children: Map<string, ChildAgent>;
	lastUpdate: number;
}

export function createState(): SubagentState {
	return {
		children: new Map(),
		lastUpdate: Date.now(),
	};
}

export function getCounts(state: SubagentState): {
	running: number;
	done: number;
	error: number;
} {
	let running = 0;
	let done = 0;
	let error = 0;
	for (const child of state.children.values()) {
		if (child.status === "running") running++;
		else if (child.status === "done") done++;
		else if (child.status === "error") error++;
	}
	return { running, done, error };
}

export function addChild(
	state: SubagentState,
	id: string,
	name: string,
	role: string,
	toolCallId?: string,
): ChildAgent {
	const child: ChildAgent = {
		id,
		name,
		role,
		status: "running",
		startedAt: Date.now(),
		toolCallId,
	};
	state.children.set(id, child);
	state.lastUpdate = Date.now();
	return child;
}

export function markChildDone(state: SubagentState, id: string): boolean {
	const child = state.children.get(id);
	if (!child || child.status !== "running") return false;
	child.status = "done";
	child.endedAt = Date.now();
	state.lastUpdate = Date.now();
	return true;
}

export function markChildError(state: SubagentState, id: string): boolean {
	const child = state.children.get(id);
	if (!child || child.status !== "running") return false;
	child.status = "error";
	child.endedAt = Date.now();
	state.lastUpdate = Date.now();
	return true;
}

export function childDisplayName(child: ChildAgent): string {
	const label = child.role || child.name || "agent";
	return child.name && child.name !== child.role
		? `${child.role || "agent"}: ${child.name}`
		: label;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Format elapsed time. Running agents use nowMs; done/error agents
 * freeze at their endedAt timestamp.
 */
export function formatElapsed(child: ChildAgent, nowMs: number): string {
	const endMs =
		child.status !== "running" && child.endedAt ? child.endedAt : nowMs;
	const elapsed = Math.max(0, endMs - child.startedAt);
	const totalSeconds = Math.floor(elapsed / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const mins = Math.floor((totalSeconds % 3600) / 60);
	const secs = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	}
	return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

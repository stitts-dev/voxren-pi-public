/**
 * Smoke cassettes: one story's model run, recorded once live and replayed offline (smoke.ts, smoke-extension.ts).
 * A cassette holds the assistant turns in order (thinking, text, tool calls) and each tool's gateway response keyed by
 * operation and arguments, Jev verdicts included. Pure: no I/O besides `readCassette` and `writeCassette`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { GatewayOperation, GatewayResponse } from "../contracts";
import type { Exchange } from "../exchange-log";
import { scrubIdentifiers } from "../passage-judge";
import { SafeToolError } from "../policy";

export interface CassetteTurn {
	thinking: string[];
	text: string;
	calls: { name: string; args: unknown }[];
}
export interface CassetteTool {
	name: string;
	operation: GatewayOperation;
	args: unknown;
	/** What the live call took, ms; replay scales it (see `replayDelay`). */
	ms: number;
	response: GatewayResponse;
}
export interface Cassette {
	id: string;
	turns: CassetteTurn[];
	tools: CassetteTool[];
}

const SECRET_QUERY = /([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi;
const BEARER = /((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{12,}/g;
const SECRET_TOKEN = /\b(?:sk|pk|rk|AIza|RGAPI)[-_][A-Za-z0-9_-]{16,}/g;

/** A string with Riot IDs, match ids, key-shaped text, and any machine path removed. `paths` are literal strings (the home folder, the coach home) replaced by a placeholder home. */
export function scrubText(text: string, paths: string[] = []): string {
	let out = text;
	for (const path of [...paths].filter((item) => item.length > 3).sort((a, b) => b.length - a.length)) out = out.split(path).join("/home/user");
	return scrubIdentifiers(out.replace(SECRET_QUERY, "$1[redacted]").replace(BEARER, "$1[redacted]").replace(SECRET_TOKEN, "[redacted]"));
}

function scrubDeep<T>(value: T, paths: string[]): T {
	if (typeof value === "string") return scrubText(value, paths) as T;
	if (Array.isArray(value)) return value.map((item) => scrubDeep(item, paths)) as T;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, paths)])) as T;
	return value;
}

/**
 * The cassette for a story's exchange-log lines. A turn's tool calls take the run's tool results by name in order
 * (parallel calls finish out of order). Reasoning blocks are not tied to a turn in the log: one per turn when the counts
 * match, else all on the run's first turn. A tool that failed live is left out, so its replay fails the same way.
 */
export function buildCassette(id: string, runs: Exchange[], paths: string[] = []): Cassette {
	const turns: CassetteTurn[] = [];
	const tools: CassetteTool[] = [];
	for (const run of runs) {
		const pool = run.tools.map((tool) => ({ tool, used: false }));
		run.turns.forEach((turn, index) => {
			const calls = turn.toolCalls.map((name) => {
				const found = pool.find((item) => !item.used && item.tool.name === name);
				if (found) found.used = true;
				return { name, args: found?.tool.args ?? {} };
			});
			const thinking = run.reasoning.length === run.turns.length ? [run.reasoning[index]] : index === 0 ? run.reasoning : [];
			turns.push({ thinking, text: turn.text, calls });
		});
		for (const { tool } of pool) {
			const result = tool.result as { operation?: GatewayOperation; response?: GatewayResponse } | string | undefined;
			if (tool.ok && result && typeof result === "object" && result.response && result.operation) tools.push({ name: tool.name, operation: result.operation, args: tool.args, ms: tool.ms, response: result.response });
		}
	}
	return scrubDeep({ id, turns, tools }, paths);
}

export const readCassette = (path: string): Cassette => JSON.parse(readFileSync(path, "utf8")) as Cassette;
export const writeCassette = (path: string, cassette: Cassette) => writeFileSync(path, `${JSON.stringify(cassette, null, "\t")}\n`);

const stable = (value: unknown): string => (Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value));

/** Recorded tool time scaled to a tenth, at most 1.5 s: long enough that a spinner and a clock still animate, short enough for a smoke run. */
export const replayDelay = (ms: number) => Math.min(ms / 10, 1500);

/** The gateway a replayed coach runs on: each call answers from the cassette (the same arguments in recorded order, the last one repeating), after the scaled delay. No network, no Data Dragon, no research service. */
export function createCassetteGateway(cassette: Cassette, wait: (ms: number, signal?: AbortSignal) => Promise<void>, dataDragon?: { version: string; base: string }) {
	const taken = new Map<string, number>();
	return {
		async call(operation: GatewayOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayResponse> {
			const key = `${operation}|${stable(input)}`;
			const matches = cassette.tools.filter((tool) => `${tool.operation}|${stable(tool.args)}` === key);
			if (!matches.length) throw new SafeToolError("UPSTREAM_UNAVAILABLE");
			const at = taken.get(key) ?? 0;
			taken.set(key, at + 1);
			const tool = matches[Math.min(at, matches.length - 1)];
			await wait(replayDelay(tool.ms), signal);
			return structuredClone(tool.response);
		},
		async close() {},
		dataDragonInfo: () => dataDragon,
		async loadDataDragonInfo(): Promise<{ version: string; base: string }> {
			if (!dataDragon) throw new Error("no Data Dragon cache in this replay");
			return dataDragon;
		},
		async championLane(): Promise<string | undefined> {
			return undefined;
		},
		warmResearch() {},
		enableNoteBuilds() {},
	};
}

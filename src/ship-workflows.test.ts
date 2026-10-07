import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The two saved Workflow scripts the captain session runs to take a list of issues to approved pull requests:
 * `.claude/workflows/ship-wave.js` (the captain's run) and `ship-lead.js` (one child run per area). The static checks read each
 * script as text. The scripted run swaps `agent()` for canned answers, so no model is called and nothing is built; it shows
 * the control flow (who runs, in what order, with which model) and the result shape, not what a real agent would do.
 */
const SCRIPTS = ["ship-wave", "ship-lead"];
const text = (name: string) => readFileSync(join(import.meta.dir, "..", ".claude", "workflows", `${name}.js`), "utf8");

/** The object or array literal that starts at `start`, found by matching brackets and skipping strings and line comments. */
const literalAt = (source: string, start: number): string => {
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const char = source[i];
		if (char === "'" || char === '"' || char === "`") {
			for (i++; source[i] !== char; i++) if (source[i] === "\\") i++;
		} else if (char === "/" && source[i + 1] === "/") {
			while (source[i] !== "\n") i++;
		} else if (char === "{" || char === "[") {
			depth++;
		} else if ((char === "}" || char === "]") && --depth === 0) {
			return source.slice(start, i + 1);
		}
	}
	throw new Error("no closing bracket for the literal");
};

const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
/** Only strings, brackets, commas and `key:` names: no variable, call, spread or template interpolation. */
const isPureLiteral = (literal: string) => !literal.includes("${") && /^[\s{}[\],]*$/.test(literal.replace(STRING, "").replace(/\b[a-zA-Z]+\s*:/g, ""));

const metaOf = (script: string) => {
	const marker = "export const meta = ";
	expect(script.trimStart().startsWith(marker)).toBe(true);
	const literal = literalAt(script, script.indexOf(marker) + marker.length);
	expect(isPureLiteral(literal)).toBe(true);

	return new Function(`return (${literal});`)() as { name: string; description: string; phases?: Array<{ title: string }> };
};

/** Every top-level `const NAME_SCHEMA = {...}`, evaluated in order so a later schema may use an earlier one. */
const schemasOf = (script: string) => {
	const found: Record<string, any> = {};
	for (const match of script.matchAll(/^const ([A-Z_]+_SCHEMA) = /gm)) {
		const literal = literalAt(script, (match.index ?? 0) + match[0].length);
		found[match[1]] = new Function(...Object.keys(found), `return (${literal});`)(...Object.values(found));
	}

	return found;
};

/** Every node of a schema that says `type: "object"`. */
const objectNodes = (node: any): any[] =>
	node && typeof node === "object" ? [...(node.type === "object" ? [node] : []), ...Object.values(node).flatMap(objectNodes)] : [];

const expectWellFormed = (schema: any) => {
	expect(schema.type).toBe("object");
	for (const node of objectNodes(schema)) {
		expect(node.properties).toBeDefined();
		for (const key of node.required ?? []) expect(Object.keys(node.properties)).toContain(key);
	}
};

const tmp = mkdtempSync(join(tmpdir(), "ship-workflows-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.each(SCRIPTS)("%s (as text)", (name) => {
	test("meta is a pure literal with a name that matches the file and a description", () => {
		const meta = metaOf(text(name));
		expect(meta.name).toBe(name);
		expect(meta.description.length).toBeGreaterThan(20);
	});

	test("every phase() title and every phase option names an entry of meta.phases", () => {
		const script = text(name);
		const titles = (metaOf(script).phases ?? []).map((phase) => phase.title);
		const calls = [...script.matchAll(/\bphase\(\s*(['"])(.+?)\1\s*\)/g)].map((match) => match[2]);
		const options = [...script.matchAll(/\bphase:\s*(['"])(.+?)\1/g)].map((match) => match[2]);
		// A title built at run time would slip past the two lists above, so every call must be one of them.
		expect(script.match(/\bphase\(/g)?.length).toBe(calls.length);
		expect(script.match(/\bphase:/g)?.length).toBe(options.length);
		expect(calls.length + options.length).toBeGreaterThan(0);
		for (const used of [...calls, ...options]) expect(titles).toContain(used);
	});

	test("no wall clock, no randomness, and never the broken worktree option", () => {
		expect(text(name)).not.toMatch(/Date\.now|Math\.random|new Date\(\s*\)|isolation\s*:/);
	});

	test("every schema is an object whose required keys are all properties", () => {
		const schemas = Object.values(schemasOf(text(name)));
		expect(schemas.length).toBeGreaterThan(0);
		for (const schema of schemas) expectWellFormed(schema);
	});

	test("passes node --check once the top-level return is wrapped in a function", () => {
		const wrapped = `async function body(args, agent, parallel, pipeline, phase, log, workflow, budget) {\n${text(name).replace("export const meta", "const meta")}\n}\n`;
		const file = join(tmp, `${name}.js`);
		writeFileSync(file, wrapped);
		const ran = spawnSync("node", ["--check", file], { encoding: "utf8" });
		expect(ran.stderr).toBe("");
		expect(ran.status).toBe(0);
	});
});

test("ship-wave runs ship-lead as a child workflow", () => {
	expect(text("ship-wave")).toContain("workflow('ship-lead'");
});

test("the schemas pin the four cards of the contract", () => {
	const keys = (schema: any) => ({ properties: Object.keys(schema.properties).sort(), required: [...schema.required].sort() });
	const pinned = (fields: string[]) => ({ properties: [...fields].sort(), required: [...fields].sort() });
	const wave = schemasOf(text("ship-wave"));
	const lead = schemasOf(text("ship-lead"));
	expect(keys(wave.TRIAGE_CARD_SCHEMA)).toEqual(pinned(["issue", "kind", "area", "size", "claim", "needs_owner", "confidence"]));
	expect(keys(lead.TASK_CARD_SCHEMA)).toEqual(pinned(["id", "issue", "objective", "gate", "files_owned", "steps", "branch", "depends_on"]));
	expect(keys(lead.WORKER_RESULT_SCHEMA)).toEqual(pinned(["task", "pr", "failing_before", "mutations", "gate_output", "not_verified"]));
	expect(keys(lead.VERDICT_SCHEMA)).toEqual(pinned(["task", "approve", "must_fix", "should_fix", "evidence"]));
	expect(wave.TRIAGE_CARD_SCHEMA.properties.kind.enum).toEqual(["bug", "feature", "chore"]);
	expect(wave.TRIAGE_CARD_SCHEMA.properties.size.enum).toEqual(["xs", "s", "m", "l"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// A scripted run of ship-wave: the Workflow runtime's globals, with agent() answering from a table.

type Call = { prompt: string; opts: { label?: string; phase?: string; schema?: any; model?: string; effort?: string } };
type Trace = { calls: Call[]; workflows: Array<{ name: string; args: any }> };
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...params: string[]) => (...values: unknown[]) => Promise<any>;

/** Runs a script the way the runtime would, one level of workflow() deep (a child that calls workflow() throws, as it does there). */
const execute = (name: string, args: unknown, respond: (call: Call) => unknown, record: Trace, depth = 0): Promise<any> => {
	const agent = async (prompt: string, opts: Call["opts"] = {}) => {
		record.calls.push({ prompt, opts });

		return respond({ prompt, opts });
	};
	const workflow = (child: string, childArgs: unknown) => {
		if (depth > 0) throw new Error("workflow() inside a child workflow");
		record.workflows.push({ name: child, args: childArgs });

		return execute(child, childArgs, respond, record, depth + 1);
	};
	const parallel = (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((thunk) => thunk()));
	const pipeline = (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>) =>
		Promise.all(
			items.map(async (item, index) => {
				let prev: unknown = item;
				for (const stage of stages) prev = await stage(prev, item, index);

				return prev;
			}),
		);
	const nothing = () => undefined;
	const body = text(name).replace("export const meta", "const meta");
	const run = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", "workflow", "budget", body);

	return run(args, agent, parallel, pipeline, nothing, nothing, workflow, { total: null, spent: () => 0, remaining: () => Infinity });
};

const triageCard = (issue: number, area: string, needsOwner = false) => ({ issue, kind: "bug", area, size: "xs", claim: `claim ${issue}`, needs_owner: needsOwner, confidence: 0.9 });
const taskCard = (id: string, issue: number, files: string[], branch: string, dependsOn: string[] = []) => ({
	id,
	issue,
	objective: `objective ${id}`,
	gate: { command: `bun test ${id}`, expect: "all pass" },
	files_owned: files,
	steps: ["one", "two"],
	branch,
	depends_on: dependsOn,
});

const ISSUES = [11, 12, 13, 14, 15, 16, 17, 18];
const TRIAGE: Record<number, unknown> = {
	11: triageCard(11, "ui"),
	12: triageCard(12, "UI "),
	// A triage agent that mislabels its own issue: the script must keep the number it asked about.
	13: { ...triageCard(13, "ui"), issue: 999 },
	14: triageCard(14, "bin"),
	15: triageCard(15, "bin", true),
	17: triageCard(17, "bin"),
	18: triageCard(18, "bin"),
};
const PLANS: Record<string, unknown> = {
	ui: {
		tasks: [
			taskCard("11-a", 11, ["src/a.ts", "src/a.test.ts"], "fix/a"),
			// Owns a file 11-a owns and says nothing about it: the script must put it behind 11-a.
			taskCard("12-b", 12, ["src/a.ts"], "fix/b"),
			// Depends on a card that does not exist: the script must drop that, not wait on it.
			taskCard("13-c", 13, ["src/c.ts"], "fix/c", ["99-nothing"]),
		],
		dropped: [],
		decisions_needed: [],
	},
	bin: {
		tasks: [taskCard("14-d", 14, ["bin/d.mjs"], "fix/d")],
		dropped: [{ issue: 17, why: "already fixed on origin/main" }],
		decisions_needed: [{ issue: 15, question: "which way?", options: ["x", "y"], recommendation: "x" }],
		// Issue 18 appears nowhere: the script must report it.
	},
};
/** What the skeptic says to `id` in `round`: 11-a needs one fix, 13-c is never satisfied, 14-d is approved with one optional item. */
const verdict = (id: string, round: number) => {
	const base = { task: id, approve: true, must_fix: [] as string[], should_fix: [] as string[], evidence: `evidence ${id} r${round}` };
	if (id === "11-a" && round === 1) return { ...base, approve: false, must_fix: ["m1"] };
	if (id === "13-c") return { ...base, approve: false, must_fix: ["never satisfied"] };
	if (id === "14-d" && round === 1) return { ...base, should_fix: ["s1"] };

	return base;
};

const respond = (call: Call): unknown => {
	const label = call.opts.label ?? "";
	const id = label.split(" ")[1] ?? "";
	switch (call.opts.phase) {
		case "Triage":
			return TRIAGE[Number(/#(\d+)/.exec(label)?.[1])] ?? null;
		case "Plan":
			return PLANS[id];
		case "Build":
			return { task: id, pr: `https://example.test/pull/${id}`, failing_before: "saw it fail", mutations: "two, both caught", gate_output: "all pass", not_verified: "" };
		case "Review":
			return verdict(id, Number(/ r(\d+)$/.exec(label)?.[1]));
		case "Fix":
			return { pushed: true, head: "abc1234", changes: "did it", checks: "green", declined: "" };
		case "Verify":
			return { results: ["11-a", "12-b", "13-c", "14-d"].filter((card) => call.prompt.includes(`"${card}"`)).map((card) => ({ task: card, pass: card !== "14-d", output: `gate output ${card}` })) };
		default:
			throw new Error(`no scripted answer for ${JSON.stringify(call.opts)}`);
	}
};

test("a ship-lead child that crashes fails each of its issues by name, and the other area still ships", async () => {
	const record: Trace = { calls: [], workflows: [] };
	const crashBin = (call: Call) => {
		if (call.opts.phase === "Plan" && call.opts.label === "plan bin") throw new Error("lead fell over");

		return respond(call);
	};
	const result = await execute("ship-wave", { issues: [11, 14, 15, 17, 18] }, crashBin, record);
	const failed = Object.fromEntries(result.failed.map((entry: { task: string; why: string }) => [entry.task, entry.why]));
	for (const issue of ["#14", "#15", "#17", "#18"]) expect(failed[issue]).toContain("crashed");
	expect(failed["#14"]).toContain("lead fell over");
	expect(result.approved.map((entry: { task: string }) => entry.task)).toEqual(["11-a"]);
});

describe("ship-wave with scripted agents", () => {
	const record: Trace = { calls: [], workflows: [] };
	const ran = execute("ship-wave", { issues: ISSUES, decisionLog: 99 }, respond, record);
	const indexOf = (label: string) => record.calls.findIndex((call) => call.opts.label === label);
	const promptOf = (label: string) => record.calls[indexOf(label)]?.prompt ?? "";

	test("returns approved, failed and decisions_needed, and nothing else", async () => {
		const result = await ran;
		expect(Object.keys(result).sort()).toEqual(["approved", "decisions_needed", "failed"]);
		expect(result.approved).toEqual([
			{ task: "11-a", pr: "https://example.test/pull/11-a" },
			{ task: "12-b", pr: "https://example.test/pull/12-b" },
		]);
		expect(result.decisions_needed).toEqual([{ issue: 15, question: "which way?", options: ["x", "y"], recommendation: "x" }]);
		const failed = Object.fromEntries(result.failed.map((entry: { task: string; why: string }) => [entry.task, entry.why]));
		expect(Object.keys(failed).sort()).toEqual(["#16", "#17", "#18", "13-c", "14-d"]);
		expect(failed["#16"]).toContain("triage");
		expect(failed["#17"]).toContain("already fixed on origin/main");
		expect(failed["#18"]).toContain("no task, drop or decision");
		expect(failed["13-c"]).toContain("never satisfied");
		expect(failed["14-d"]).toContain("gate output 14-d");
	});

	test("groups the cards by area, one ship-lead child per area, the decision log passed on", async () => {
		await ran;
		expect(record.workflows.map((call) => call.name)).toEqual(["ship-lead", "ship-lead"]);
		expect(record.workflows.map((call) => call.args.area).sort()).toEqual(["bin", "ui"]);
		expect(record.workflows.every((call) => call.args.decisionLog === 99)).toBe(true);
		const ui = record.workflows.find((call) => call.args.area === "ui");
		expect(ui?.args.cards.map((card: { issue: number }) => card.issue)).toEqual([11, 12, 13]);
	});

	test("each stage runs on the model and effort the contract names", async () => {
		await ran;
		const used = (phase: string) => [...new Set(record.calls.filter((call) => call.opts.phase === phase).map((call) => `${call.opts.model}/${call.opts.effort}`))];
		expect(used("Triage")).toEqual(["haiku/low"]);
		expect(used("Plan")).toEqual(["sonnet/high"]);
		expect(used("Build")).toEqual(["sonnet/low"]);
		expect(used("Review")).toEqual(["sonnet/medium"]);
		expect(used("Verify")).toEqual(["sonnet/high"]);
		expect(used("Fix")).toHaveLength(1);
		expect(used("Fix")[0]).toStartWith("sonnet/");
		expect(record.calls.every((call) => !("isolation" in call.opts))).toBe(true);
	});

	test("every schema an agent is given is well formed", async () => {
		await ran;
		expect(new Set(record.calls.map((call) => call.opts.phase))).toEqual(new Set(["Triage", "Plan", "Build", "Review", "Fix", "Verify"]));
		for (const call of record.calls) expectWellFormed(call.opts.schema);
	});

	test("a card that shares a file waits for the card that owns it, and builds on its branch", async () => {
		await ran;
		expect(indexOf("build 12-b")).toBeGreaterThan(indexOf("skeptic 11-a r2"));
		expect(promptOf("build 12-b")).toContain("origin/fix/a");
		expect(promptOf("build 12-b")).toContain("--base fix/a");
		expect(promptOf("build 11-a")).toContain("origin/main");
		expect(promptOf("build 11-a")).toContain("--base main");
		// The card that named a dependency that does not exist is built from main without waiting.
		expect(promptOf("build 13-c")).toContain("--base main");
		expect(indexOf("build 13-c")).toBeLessThan(indexOf("skeptic 11-a r2"));
	});

	test("at most two fix rounds per pull request, then the card fails", async () => {
		await ran;
		const labels = record.calls.map((call) => call.opts.label);
		expect(labels.filter((label) => label?.startsWith("fix 13-c"))).toEqual(["fix 13-c r1", "fix 13-c r2"]);
		expect(labels.filter((label) => label?.startsWith("skeptic 13-c"))).toEqual(["skeptic 13-c r1", "skeptic 13-c r2", "skeptic 13-c r3"]);
		expect(labels.filter((label) => label?.startsWith("fix 11-a"))).toEqual(["fix 11-a r1"]);
		// An approval that still lists an optional item gets one finishing pass.
		expect(labels.filter((label) => label?.startsWith("fix 14-d"))).toEqual(["fix 14-d r1"]);
	});

	test("the lead re-runs the gates of the approved cards only", async () => {
		await ran;
		const ui = promptOf("verify ui");
		expect(ui).toContain('"11-a"');
		expect(ui).toContain('"12-b"');
		expect(ui).not.toContain('"13-c"');
		expect(promptOf("verify bin")).toContain('"14-d"');
	});

	test("an agent that works in the repository derives its root, and no prompt carries a machine path", async () => {
		await ran;
		const working = record.calls.filter((call) => call.opts.phase !== "Triage");
		expect(working.length).toBeGreaterThan(0);
		for (const call of working) expect(call.prompt).toContain("git rev-parse --show-toplevel");
		for (const call of record.calls) expect(call.prompt).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\Users\\/);
	});

	test("a child workflow that calls workflow() throws, so ship-lead never does", async () => {
		await ran;
		expect(text("ship-lead")).not.toMatch(/\bworkflow\(/);
	});
});

test("ship-wave refuses a call with no issues", async () => {
	await expect(execute("ship-wave", { issues: [] }, respond, { calls: [], workflows: [] })).rejects.toThrow("issues");
});

// ---------------------------------------------------------------------------------------------------------------------
// ship-lead on its own, with plans that break the lead's own rules.

describe("ship-lead guards", () => {
	const lead = async (plan: unknown, cards: number[], verifyPass: (id: string) => boolean = () => true, over: (call: Call) => unknown = () => undefined) => {
		const record: Trace = { calls: [], workflows: [] };
		const answer = (call: Call): unknown => {
			const id = (call.opts.label ?? "").split(" ")[1] ?? "";
			const scripted = over(call);
			if (scripted !== undefined) return scripted;
			if (call.opts.phase === "Plan") return plan;
			if (call.opts.phase === "Build") return { task: id, pr: `https://example.test/pull/${id}`, failing_before: "x", mutations: "x", gate_output: "x", not_verified: "" };
			if (call.opts.phase === "Review") return { task: id, approve: true, must_fix: [], should_fix: [], evidence: "ok" };
			if (call.opts.phase === "Verify") return { results: [...call.prompt.matchAll(/"id": "([^"]+)"/g)].map((m) => ({ task: m[1], pass: verifyPass(m[1] ?? ""), output: `out ${m[1]}` })) };
			throw new Error("unscripted");
		};
		const result = await execute("ship-lead", { area: "ui", cards: cards.map((n) => triageCard(n, "ui")) }, answer, record);

		return { result, record };
	};
	const plan = (tasks: unknown[]) => ({ tasks, dropped: [], decisions_needed: [] });
	const names = (list: Array<{ task: string }>) => list.map((x) => x.task);

	test("a second card with the same id is failed under its own name, and the first stays approved", async () => {
		const { result } = await lead(plan([taskCard("11-a", 11, ["src/a.ts"], "fix/a"), taskCard("11-a", 12, ["src/b.ts"], "fix/b")]), [11, 12]);
		expect(names(result.approved)).toEqual(["11-a"]);
		expect(names(result.failed)).toContain("11-a (duplicate)");
		expect(names(result.failed)).not.toContain("11-a");
	});

	test("a task for an issue outside the area is left out, never built", async () => {
		const { result, record } = await lead(plan([taskCard("11-a", 11, ["src/a.ts"], "fix/a"), taskCard("99-x", 99, ["src/x.ts"], "fix/x")]), [11]);
		expect(record.calls.some((c) => c.opts.label === "build 99-x")).toBe(false);
		expect(names(result.approved)).toEqual(["11-a"]);
	});

	test("branches that differ only in / and - get different worktree folders", async () => {
		const { record } = await lead(plan([taskCard("11-a", 11, ["src/a.ts"], "fix/a-b"), taskCard("12-b", 12, ["src/b.ts"], "fix/a/b")]), [11, 12]);
		const folders = record.calls.filter((c) => c.opts.phase === "Build").map((c) => /worktrees\/(\S+) -b /.exec(c.prompt)?.[1]);
		expect(folders).toHaveLength(2);
		expect(new Set(folders).size).toBe(2);
	});

	test("a child stacked on a parent whose gate fails in the verify is failed too", async () => {
		const { result } = await lead(plan([taskCard("11-a", 11, ["src/a.ts"], "fix/a"), taskCard("12-b", 12, ["src/a.ts"], "fix/b")]), [11, 12], (id) => id !== "11-a");
		expect(result.approved).toEqual([]);
		const failed = Object.fromEntries(result.failed.map((f: { task: string; why: string }) => [f.task, f.why]));
		expect(failed["12-b"]).toContain("11-a");
	});

	const labels = (record: Trace) => record.calls.map((c) => c.opts.label);
	const two = plan([taskCard("11-a", 11, ["src/a.ts"], "fix/a"), taskCard("12-b", 12, ["src/a.ts"], "fix/b")]);

	test("a child stacked on a parent that was not approved is failed and never built", async () => {
		const reject = (c: Call) => (c.opts.phase === "Review" && c.opts.label?.includes("11-a") ? { task: "11-a", approve: false, must_fix: ["no"], should_fix: [], evidence: "bad" } : undefined);
		const { result, record } = await lead(two, [11, 12], () => true, (c) => (c.opts.phase === "Fix" ? { pushed: true, head: "a", changes: "", checks: "", declined: "" } : reject(c)));
		expect(labels(record)).not.toContain("build 12-b");
		expect(names(result.failed).sort()).toEqual(["11-a", "12-b"]);
	});

	test("a fixer that pushed nothing ends the loop with no further skeptic round", async () => {
		const over = (c: Call) => {
			if (c.opts.phase === "Review") return { task: "11-a", approve: false, must_fix: ["m"], should_fix: [], evidence: "e" };
			if (c.opts.phase === "Fix") return { pushed: false, head: "", changes: "", checks: "", declined: "x" };
		};
		const { result, record } = await lead(plan([taskCard("11-a", 11, ["src/a.ts"], "fix/a")]), [11], () => true, over);
		expect(labels(record).filter((l) => l?.startsWith("skeptic"))).toEqual(["skeptic 11-a r1"]);
		expect(labels(record).filter((l) => l?.startsWith("fix"))).toEqual(["fix 11-a r1"]);
		expect(names(result.failed)).toEqual(["11-a"]);
	});

	test("a builder with no pull request fails the card and no skeptic is called", async () => {
		const over = (c: Call) => (c.opts.phase === "Build" ? { task: "11-a", pr: "", failing_before: "", mutations: "", gate_output: "", not_verified: "could not push" } : undefined);
		const { result, record } = await lead(plan([taskCard("11-a", 11, ["src/a.ts"], "fix/a")]), [11], () => true, over);
		expect(labels(record).some((l) => l?.startsWith("skeptic"))).toBe(false);
		expect(result.failed[0].why).toContain("could not push");
	});
});

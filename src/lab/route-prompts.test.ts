import { describe, expect, test } from "bun:test";
import { COACH_YAML, COMMAND_PHASES } from "../contracts";
import { ROUTE_PROMPTS } from "./route-prompts";

describe("route lab prompts", () => {
	test("every row's command is offered in its phase", () => {
		for (const row of ROUTE_PROMPTS) expect(COACH_YAML.jev.command.phases[row.phase]).toContain(row.command);
	});

	test("every command a phase offers is labelled by at least one row of that phase", () => {
		for (const phase of COMMAND_PHASES) {
			for (const command of COACH_YAML.jev.command.phases[phase]) expect(ROUTE_PROMPTS.filter((row) => row.phase === phase && row.command === command).length).toBeGreaterThan(0);
		}
	});

	test("at least 60 rows, 15 per phase, no prompt twice", () => {
		expect(ROUTE_PROMPTS.length).toBeGreaterThanOrEqual(60);
		for (const phase of COMMAND_PHASES) expect(ROUTE_PROMPTS.filter((row) => row.phase === phase).length).toBeGreaterThanOrEqual(15);
		expect(new Set(ROUTE_PROMPTS.map((row) => row.prompt)).size).toBe(ROUTE_PROMPTS.length);
	});
});

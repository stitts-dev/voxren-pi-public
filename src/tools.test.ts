import { beforeEach, describe, expect, test } from "bun:test";
import { COACH_YAML, RESEARCH_CONTRACT_VERSION, type ResearchGateway } from "./contracts";
import { createCoachTools, withCommandFrames } from "./tools";

const asked: string[] = [];
const inner: ResearchGateway = {
	call: async (operation) => {
		asked.push(operation);
		return { version: RESEARCH_CONTRACT_VERSION, operation, data: { inner: true }, evidence: [] };
	},
	close: async () => {},
};
const frameTool = (load: (command: string) => Promise<Record<string, unknown>>) => createCoachTools(withCommandFrames(inner, load)).find((tool) => tool.name === "voxren_command_frame")!;

beforeEach(() => {
	asked.length = 0;
});

describe("voxren_command_frame", () => {
	test("voxren_command_frame returns the loaded frame as data with no evidence and never asks the inner gateway", async () => {
		const tool = frameTool(async (command) => ({ command, frame: `frame of ${command}` }));
		const result: any = await tool.execute("c", { command: "build" });
		expect(JSON.parse(result.content[0].text)).toEqual({ version: RESEARCH_CONTRACT_VERSION, operation: "command_frame", data: { command: "build", frame: "frame of build" }, evidence: [] });
		expect(asked).toEqual([]);
	});

	test("voxren_command_frame refuses a name no phase offers before anything loads", async () => {
		let loaded = false;
		const tool = frameTool(async (command) => {
			loaded = true;
			return { command };
		});
		for (const command of ["nope", "otp"]) {
			const result: any = await tool.execute("c", { command });
			expect(result.content[0].text).toContain("ERROR[VALIDATION]");
		}
		expect(loaded).toBe(false);
	});

	test("voxren_command_frame accepts every command some phase offers", async () => {
		const tool = frameTool(async (command) => ({ command, frame: "x" }));
		const names = [...new Set(Object.values(COACH_YAML.jev.command.phases).flat())].filter((name) => name !== "none");
		for (const command of names) {
			const result: any = await tool.execute("c", { command });
			expect(result.content[0].text).not.toContain("ERROR[");
		}
	});
});

describe("withCommandFrames", () => {
	test("withCommandFrames passes every other operation to the inner gateway", async () => {
		const response = await withCommandFrames(inner, async () => ({})).call("remember", { text: "x" });
		expect(response).toEqual({ version: RESEARCH_CONTRACT_VERSION, operation: "remember", data: { inner: true }, evidence: [] });
		expect(asked).toEqual(["remember"]);
	});
});

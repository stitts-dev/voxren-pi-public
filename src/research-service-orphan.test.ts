import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { findOnPath, researchStatePath } from "./research-service";

const uv = findOnPath("uv", process.env.PATH);
const runs = uv && process.platform !== "win32" ? test : test.skip;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(done: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (done()) return true;
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	return done();
}

runs(
	"a shared service whose starter is killed with SIGKILL leaves by itself",
	async () => {
		const home = mkdtempSync(join(tmpdir(), "research-orphan-"));
		const environment = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: join(home, "agent") };
		const statePath = researchStatePath(environment)!;
		const script = join(home, "starter.ts");
		writeFileSync(script, `import { createResearchService } from ${JSON.stringify(join(import.meta.dir, "research-service"))};\ncreateResearchService(process.env)!.warm();\nsetInterval(() => {}, 1000);\n`);
		const starter = Bun.spawn([process.execPath, script], { env: environment as Record<string, string>, stdio: ["ignore", "ignore", "ignore"] });
		let servicePid = 0;
		try {
			expect(await until(() => existsSync(statePath), 60_000)).toBe(true);
			servicePid = JSON.parse(readFileSync(statePath, "utf8")).pid;
			expect(alive(servicePid)).toBe(true);
			starter.kill("SIGKILL");
			await starter.exited;
			expect(await until(() => !alive(servicePid), 10_000)).toBe(true);
		} finally {
			if (servicePid && alive(servicePid)) process.kill(servicePid);
			starter.kill("SIGKILL");
			rmSync(home, { recursive: true, force: true });
		}
	},
	90_000,
);

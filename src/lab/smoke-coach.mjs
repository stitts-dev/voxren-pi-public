/**
 * The coach for a smoke run (src/lab/smoke.ts): the real launcher's Pi invocation with the smoke extension in place of
 * the coach's own, no keys from .env or the key store, and Pi offline. VOXREN_SMOKE_CASSETTE names the recording to replay.
 * Nothing here is loaded by the shipped coach.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORWARDED_ENV, STORE_BACKED_ENV, PROVIDER_KEY_ENV, EXTENSION, createPiInvocation, createRuntime, piCommand } from "../../bin/coach.mjs";

const SECRETS = new Set([...Object.values(PROVIDER_KEY_ENV), ...Object.keys(STORE_BACKED_ENV), "BRAVE_API_KEY", "VOXREN_RESEARCH_URL", "VOXREN_RESEARCH_TOKEN"]);
const values = Object.fromEntries(FORWARDED_ENV.filter((name) => !SECRETS.has(name) && process.env[name]?.trim()).map((name) => [name, process.env[name].trim()]));
// A research service the tools think is there, so the tool list matches a live run; the cassette gateway never calls it.
values.VOXREN_RESEARCH_URL = "http://127.0.0.1:9";
values.VOXREN_RESEARCH_TOKEN = "smoke";
const { args, childEnv } = createPiInvocation(createRuntime(), values, ["--api-key", "smoke"]);
// Pi reads --models before an extension registers its provider and would warn about every name; cycling models is not part of a smoke run.
const models = args.indexOf("--models");
const swapped = args.filter((_, index) => index !== models && index !== models + 1 || models < 0).map((arg) => (arg === EXTENSION ? fileURLToPath(new URL("./smoke-extension.ts", import.meta.url)) : arg));
const pi = piCommand();
const result = spawnSync(pi.command, [...pi.prefix, ...swapped], {
	cwd: createRuntime().cwd,
	env: { ...childEnv, PI_OFFLINE: "1", ...Object.fromEntries(["VOXREN_SMOKE_CASSETTE", "VOXREN_SMOKE_NET_LOG", "VOXREN_SMOKE_TPS", "VOXREN_SMOKE_DDRAGON", "VOXREN_SMOKE_WARM", "VOXREN_SMOKE_ICON_MISS"].filter((name) => process.env[name]).map((name) => [name, process.env[name]])) },
	stdio: "inherit",
	shell: pi.shell,
});
process.exitCode = result.status ?? 1;

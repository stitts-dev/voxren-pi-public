import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { logEvent } from "./coach-log";

/**
 * Runs `step`, retrying while Windows reports the file busy (EPERM, EBUSY, EACCES): another window is renaming or
 * reading it at that instant, which POSIX allows and Windows does not. ponytail: 40 tries 10 ms apart (about half a
 * second of contention), then the error is thrown as before.
 */
function retryWhileBusy<T>(step: () => T): T {
	for (let attempt = 1; ; attempt++) {
		try {
			return step();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= 40 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
}

/** Moves a JSON file that exists but will not read or parse to `<path>.corrupt-<time>`, so the save that follows cannot destroy it. False when it could not be moved: the caller must then not write. `component` tags the log lines. */
export function setAsideIfDamaged(path: string, component: string): boolean {
	try {
		JSON.parse(retryWhileBusy(() => readFileSync(path, "utf8")));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		const aside = `${path}.corrupt-${Date.now()}`;
		try {
			renameSync(path, aside);
			logEvent("warn", component, "corrupt-moved-aside", { path, aside }, error);
			return true;
		} catch (renameError) {
			logEvent("error", component, "save-refused-damaged-file", { path }, renameError);
			return false;
		}
	}
}

/** Write-then-rename through a per-process temp file, flushed before the rename, so windows sharing a file never share a temp name and a crash never leaves half a file. */
export function writeFileAtomic(path: string, text: string | Uint8Array, component: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		const fd = openSync(tmp, "w");
		try {
			if (typeof text === "string") writeSync(fd, text);
			else writeSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		retryWhileBusy(() => renameSync(tmp, path));
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch (cleanupError) {
			logEvent("warn", component, "tmp-cleanup-failed", { tmp }, cleanupError);
		}
		throw error;
	}
}

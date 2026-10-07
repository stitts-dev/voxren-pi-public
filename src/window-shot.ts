/**
 * The pixels and the text of a WezTerm window: PrintWindow on Windows, `screencapture -l` on macOS (the window's own
 * pixels, covered or not, at real resolution), and `wezterm cli get-text` for what its pane shows. Used by the WezTerm
 * lab (src/lab/wezterm.ts) and by /report, which hands the coach's own window to the debug session.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface WezWindow {
	/** The wezterm-gui process, owner of the window. */
	pid: number;
	pane: string;
	socket: string;
	/** The `wezterm` command-line executable (not -gui). */
	cli: string;
}

/** The WezTerm window a process runs in, from the variables WezTerm gives every pane (its socket is named for the GUI's pid). */
export function wezWindow(environment: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): WezWindow | undefined {
	const { WEZTERM_UNIX_SOCKET: socket, WEZTERM_PANE: pane, WEZTERM_EXECUTABLE_DIR: dir } = environment;
	const pid = Number(/gui-sock-(\d+)$/.exec(socket ?? "")?.[1]);
	return socket && pid && pane && dir ? { pid, pane, socket, cli: platform === "win32" ? win32.join(dir, "wezterm.exe") : posix.join(dir, "wezterm") } : undefined;
}

/** What the pane shows as text, trailing blanks trimmed; "" when WezTerm does not answer. */
export function paneText({ cli, socket, pane }: WezWindow): string {
	const result = spawnSync(cli, ["cli", "--no-auto-start", "get-text", "--pane-id", pane], { encoding: "utf8", timeout: 10_000, windowsHide: true, env: { ...process.env, WEZTERM_UNIX_SOCKET: socket } });
	return result.status === 0 ? (result.stdout ?? "").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim() : "";
}

/** macOS: the window's CGWindowID, for `screencapture -l`. Listing windows needs no permission; capturing one does. */
function macWindowId(pid: number): number {
	// WezTerm owns several hidden helper windows too: the terminal is the largest one on screen.
	const script = `ObjC.import("CoreGraphics"); JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID))).filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer === 0 && w.kCGWindowIsOnscreen).sort((a, b) => b.kCGWindowBounds.Width * b.kCGWindowBounds.Height - a.kCGWindowBounds.Width * a.kCGWindowBounds.Height).map((w) => w.kCGWindowNumber))`;
	const ids: number[] = JSON.parse(spawnSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" }).stdout || "[]");
	const id = ids[0];
	if (id === undefined) throw new Error(`No window for pid ${pid}.`);
	return id;
}

/**
 * `count` captures of window `pid`'s window `everyMs` apart. `file` takes a printf-style `%04d` for the frame number when
 * count > 1. Resolves "WxH"; rejects with the cause. Asynchronous so a caller can type while frames are taken.
 */
export async function captureWindow(pid: number, file: string, count = 1, everyMs = 0): Promise<string> {
	if (process.platform === "darwin") {
		const id = macWindowId(pid);
		mkdirSync(dirname(file), { recursive: true });
		const started = Date.now();
		let last = "";
		for (let frame = 1; frame <= count; frame++) {
			last = file.replace("%04d", String(frame).padStart(4, "0"));
			const shot = spawnSync("screencapture", ["-x", "-o", "-l", String(id), last], { encoding: "utf8" });
			// ponytail: one process per frame, so `record` tops out near 5 fps; a ScreenCaptureKit helper if that is too slow.
			if (shot.status !== 0 || !existsSync(last)) throw new Error(`screencapture: ${shot.stderr.trim() || "no image"}. Allow Screen Recording for this terminal, or for sshd-keygen-wrapper over SSH (System Settings → Privacy & Security).`);
			const wait = everyMs * frame - (Date.now() - started);
			if (wait > 0) await sleep(wait);
		}
		const sips = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", last], { encoding: "utf8" }).stdout;
		return `${/pixelWidth: (\d+)/.exec(sips)?.[1]}x${/pixelHeight: (\d+)/.exec(sips)?.[1]}`;
	}
	if (process.platform !== "win32") throw new Error(`No window capture on ${process.platform}.`);
	const script = `Add-Type -AssemblyName System.Drawing
Add-Type 'using System; using System.Runtime.InteropServices; public static class Shot { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); public struct RECT { public int L, T, R, B; } }'
[void][Shot]::SetProcessDPIAware()
$h = (Get-Process -Id ${pid}).MainWindowHandle
$file = '${file.replace(/'/g, "''")}'
New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
$clock = [Diagnostics.Stopwatch]::StartNew()
for ($i = 1; $i -le ${count}; $i++) {
  $r = New-Object Shot+RECT; [void][Shot]::GetWindowRect($h, [ref]$r)
  $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
  [void][Shot]::PrintWindow($h, $dc, 2); $g.ReleaseHdc($dc); $g.Dispose()
  $bmp.Save(($file -replace '%04d', $i.ToString('0000'))); $size = "$($bmp.Width)x$($bmp.Height)"; $bmp.Dispose()
  $wait = [int](${everyMs} * $i - $clock.ElapsedMilliseconds); if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}
$size`;
	return new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (err += chunk));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `PowerShell exited ${code}`))));
	});
}

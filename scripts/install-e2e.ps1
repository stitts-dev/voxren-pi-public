# Clean-machine check of the README one-liner (#126). Runs it twice as a throwaway user: a temp HOME/USERPROFILE and
# npm prefix. Prints the lines the issue asks for, then deletes everything it made. Run: powershell -File scripts\install-e2e.ps1
#   $env:INSTALL_URL = 'file:///C:/x/install.mjs'; $env:VOXREN_REPO = 'C:\x\origin.git'   pre-public: a local copy
$ErrorActionPreference = 'Continue'
$url = if ($env:INSTALL_URL) { $env:INSTALL_URL } else { 'https://raw.githubusercontent.com/stitts-dev/voxren-pi-public/main/bin/install.mjs' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('install-e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$realPath = $env:PATH
New-Item -ItemType Directory -Path "$root\work", "$root\home" | Out-Null
try {
	$env:USERPROFILE = "$root\home"; $env:HOME = "$root\home"
	$env:APPDATA = "$root\home\AppData\Roaming"; $env:LOCALAPPDATA = "$root\home\AppData\Local"
	New-Item -ItemType Directory -Path $env:APPDATA, $env:LOCALAPPDATA | Out-Null
	$env:NPM_CONFIG_PREFIX = "$root\prefix"; $env:NPM_CONFIG_CACHE = "$root\home\npm-cache"
	New-Item -ItemType Directory -Path $env:NPM_CONFIG_PREFIX | Out-Null
	# A clean user has no pi and no coach: drop every PATH folder that holds one (often the Node folder itself), and
	# give the run its own node.exe and an npm shim in their place.
	$kept = $realPath -split ';' | Where-Object { $_ -and -not (Test-Path (Join-Path $_ 'pi.cmd')) -and -not (Test-Path (Join-Path $_ 'coach.cmd')) }
	$nodeDir = Split-Path (Get-Command node).Source
	New-Item -ItemType Directory -Path "$root\tools" | Out-Null
	Copy-Item "$nodeDir\node.exe" "$root\tools\node.exe"
	Set-Content "$root\tools\npm.cmd" "@call `"$nodeDir\npm.cmd`" %*"
	$env:PATH = "$root\prefix;$root\tools;" + ($kept -join ';')
	Set-Location "$root\work"
	"OS: $((Get-CimInstance Win32_OperatingSystem).Caption) $([Environment]::OSVersion.Version)"
	"Node: $(node -v)  npm: $(npm -v)  git: $(git --version)"
	"Line: irm $url | node"
	$status = 0
	foreach ($run in 1, 2) {
		""; "=== run $run ==="
		irm $url | node
		"exit: node=$LASTEXITCODE"
		if ($LASTEXITCODE -ne 0) { $status = 1 }
		"coach --version: $(coach --version 2>&1)"
		if (-not (Get-Command coach -ErrorAction SilentlyContinue)) { "coach is not on PATH"; $status = 1 }
	}
} finally {
	$env:PATH = $realPath
	Set-Location $env:TEMP
	Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
exit $status

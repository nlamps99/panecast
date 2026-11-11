# CI check of the cmux DR2 Windows package on a Windows machine: installs it
# the way users do (Windows PowerShell running the installer text), starts the
# gateway as the login service, drives it as a phone, opens the cmux DR2 window
# for a screenshot, stops the service and installs again as an upgrade.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = Join-Path $repo 'build\cmux-windows'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $out 'cmux-dr2-windows.json') | ConvertFrom-Json
$installer = Join-Path $out $manifest.installer.file
$shots = Join-Path $out 'smoke'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
$env:CMUX_DR2_ARCHIVE = Join-Path $out $manifest.file
$env:CMUX_DR2_SKIP_SETUP = '1'
$root = Join-Path $env:LOCALAPPDATA 'cmux-dr2'

function Install-Package {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -Raw -Encoding UTF8 -LiteralPath '$installer' | Invoke-Expression"
  if ($LASTEXITCODE) { throw "installer failed: $LASTEXITCODE" }
}
function Save-Screenshot($name) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $image = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  [System.Drawing.Graphics]::FromImage($image).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $image.Save((Join-Path $shots $name))
}

Install-Package
$bin = Join-Path $root 'bin'
& (Join-Path $bin 'cmux.exe') --version
if ($LASTEXITCODE) { throw 'cmux.exe does not run' }
if (-not (Test-Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'cmux DR2.lnk'))) { throw 'Start menu entry missing' }
if (([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') -notcontains $bin) { throw 'PATH not updated' }

# A LAN-only gateway config, so the check needs no account.
$code = [guid]::NewGuid().ToString('N')
$state = Join-Path $env:RUNNER_TEMP 'panecast-smoke'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$config = Join-Path $state 'hub-relay.json'
@{ lan = @{ pairing_code = $code }; port = 4455; host = '127.0.0.1'; state_directory = (Join-Path $state 'hub'); sources = @() } |
  ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath $config
$panecast = Join-Path $bin 'panecast.cmd'
& $panecast start --config $config
if ($LASTEXITCODE) { Get-Content -ErrorAction SilentlyContinue (Join-Path $state 'hub-log\stderr.log'); throw 'panecast start failed' }
& $panecast status --config $config

try {
  & (Join-Path $root 'node\node.exe') (Join-Path $PSScriptRoot 'smoke-client.mjs') --root $root --port 4455 --code $code
  if ($LASTEXITCODE) { throw 'phone check failed' }
  $sources = Get-Content -Raw -LiteralPath $config | ConvertFrom-Json
  if (-not ($sources.sources | Where-Object { $_.type -eq 'cmux-tui' -and $_.owner })) { throw 'cmux DR2 source not discovered' }

  # The window from the Start menu attaches to the session the phone just used.
  $window = Start-Process -PassThru -FilePath (Join-Path $bin 'cmux-dr2.cmd')
  Start-Sleep -Seconds 6
  Save-Screenshot 'cmux-dr2-window.png'
  Stop-Process -Id $window.Id -Force -ErrorAction SilentlyContinue
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$root\*" -and $_.ProcessName -eq 'cmux-tui' } |
    Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -match ' attach ' } | Stop-Process -Force
}
catch {
  Save-Screenshot 'failure.png'
  Get-Content -ErrorAction SilentlyContinue (Join-Path $state 'hub-log\stderr.log') | Select-Object -Last 40
  throw
}

& $panecast stop --config $config
Start-Sleep -Seconds 2
& $panecast status --config $config

# Upgrade over the running session: the installer ends it and replaces the files.
Install-Package
& (Join-Path $bin 'cmux.exe') --version
if ($LASTEXITCODE) { throw 'cmux.exe does not run after the upgrade' }
if (-not (Test-Path "$root.previous")) { throw 'the previous version was not kept' }
Write-Host 'cmux DR2 installed, used from a phone, opened, stopped and upgraded.'

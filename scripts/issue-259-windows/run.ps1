$ErrorActionPreference = 'Stop'
$workdir = (Get-Location).Path
$root = Join-Path $env:RUNNER_TEMP 'issue-259-windows'
$output = Join-Path $root 'evidence'
New-Item -ItemType Directory -Force $output | Out-Null
$base = '6da061e8fa51a30ed50c6fff2a4cadcddf7a4a6a'
$fixedRevision = '1a9d455004c9204a74b87c920d81b67b3f7b954f'
$expectedFixedBlob = '340e4817a695d4807142e12d09bd70e792cec847'
$source = 'plugins/dsh-mnemon-source-runtime/src/git-branch.ts'
$baselineModule = Join-Path $root 'baseline.ts'
$fixedModule = Join-Path $root 'fixed.ts'
node -e 'const fs=require("node:fs"); const cp=require("node:child_process"); fs.writeFileSync(process.argv[1], cp.execFileSync("git", ["show", process.argv[2]], {windowsHide:true}))' $baselineModule "${base}:$source"
node -e 'const fs=require("node:fs"); const cp=require("node:child_process"); fs.writeFileSync(process.argv[1], cp.execFileSync("git", ["show", process.argv[2]], {windowsHide:true}))' $fixedModule "HEAD:$source"
if ((git hash-object $source) -ne $expectedFixedBlob) { throw 'Validation source differs from exact production fix source blob' }
if (-not (Select-String -Path $fixedModule -SimpleMatch 'windowsHide: true')) { throw 'Fixed source does not have windowsHide' }
$fixture = Join-Path $root 'fixture'
$detached = Join-Path $root 'detached'
$nonRepository = Join-Path $root 'not-a-repo'
New-Item -ItemType Directory -Force $fixture, $nonRepository | Out-Null
git -C $fixture init -b console-probe
git -C $fixture -c user.name=Validation -c user.email=validation@example.invalid commit --allow-empty -m fixture
git clone --quiet $fixture $detached
git -C $detached checkout --detach --quiet
$config = @{
  workdir = $workdir; outputDir = $output; node = (Get-Command node).Source
  worker = (Join-Path $workdir 'scripts/issue-259-windows/worker.mjs')
  fixture = $fixture; detached = $detached; nonRepository = $nonRepository
  baselineModule = $baselineModule; fixedModule = $fixedModule; repetitions = 100
}
$configFile = Join-Path $root 'config.json'
$config | ConvertTo-Json | Set-Content -Encoding utf8NoBOM $configFile
$metadata = @{
  baselineRevision = $base; fixedRevision = $fixedRevision; validationRevision = (git rev-parse HEAD)
  sourcePath = $source; baselineBlob = (git rev-parse "${base}:$source"); fixedBlob = (git hash-object $source)
  baselineSha256 = (Get-FileHash $baselineModule -Algorithm SHA256).Hash
  fixedSha256 = (Get-FileHash $fixedModule -Algorithm SHA256).Hash
  node = (node --version); nodePath = (Get-Command node).Source
  git = (git --version); gitPath = (Get-Command git).Source
  runnerImage = $env:ImageOS; runnerImageVersion = $env:ImageVersion
  operatingSystem = (Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber)
}
$metadata | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8NoBOM (Join-Path $output 'metadata.json')
Copy-Item $baselineModule, $fixedModule $output
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$observer = Join-Path $root 'Observer.exe'
$observerSource = Join-Path $workdir 'scripts\issue-259-windows\Observer.cs'
& $csc /nologo /target:winexe /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/out:$observer" $observerSource
if ($LASTEXITCODE -ne 0) { throw 'Observer compilation failed' }
$process = Start-Process -FilePath $observer -ArgumentList "`"$configFile`"" -PassThru -Wait
if ($process.ExitCode -ne 0) { Get-Content (Join-Path $output 'windows-observation.json'); throw 'Observer failed' }
$report = Get-Content (Join-Path $output 'windows-observation.json') -Raw | ConvertFrom-Json
$rows = foreach ($phase in $report.phases) {
  $result = Get-Content (Join-Path $output "$($phase.phase)-result.json") -Raw | ConvertFrom-Json
  [pscustomobject]@{ Phase = $phase.phase; Exit = $phase.exitCode; VisibleWindows = $phase.newVisibleConsoleWindowCount; NodeHadConsole = $phase.nodeHadConsole; Probes = $result.probes; Branch = $result.branch; Success = $result.success }
  if ($phase.exitCode -ne 0 -or -not $result.success) { throw "Behavior failed in $($phase.phase)" }
  if (-not $phase.screenshotCaptured) { throw "Screenshot was not captured in $($phase.phase)" }
  if ($phase.phase -ne 'positive-control' -and (-not $phase.checkedConsole -or $phase.nodeHadConsole -or $phase.attachError -ne 6)) { throw "No-console parent not confirmed in $($phase.phase)" }
}
$rows | Format-Table | Out-String | Tee-Object -FilePath (Join-Path $output 'summary.txt')
$positive = $report.phases | Where-Object phase -eq 'positive-control'
$before = @($report.phases | Where-Object phase -like 'baseline-*')
$after = @($report.phases | Where-Object phase -like 'fixed-*')
if ($positive.newVisibleConsoleWindowCount -lt 1) { throw 'Inconclusive: Windows runner did not expose a visible console positive control' }
if (@($before | Where-Object newVisibleConsoleWindowCount -eq 0).Count) { throw 'Inconclusive: baseline console flash was not detected in each trial' }
if (@($after | Where-Object newVisibleConsoleWindowCount -gt 0).Count) { throw 'Fixed module still created visible console windows' }
'Observed baseline visible windows and zero fixed visible windows in both real-Git trials.' | Tee-Object -Append -FilePath (Join-Path $output 'summary.txt')

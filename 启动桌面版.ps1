$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('Desktop runtime is missing. Run npm install in the project folder.', 'Fengyue Link') | Out-Null
  exit 1
}

Start-Process -FilePath $electronPath -ArgumentList @($projectRoot, '--profile=default') -WorkingDirectory $projectRoot

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$package = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$appName = [string]$package.build.productName
$version = [string]$package.version
$appDirectory = (Resolve-Path -LiteralPath (Join-Path $root "release\win-unpacked")).Path
$executable = (Resolve-Path -LiteralPath (Join-Path $appDirectory "$appName.exe")).Path
$shortcutPaths = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "$appName.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Programs")) "$appName.lnk")
)

$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in $shortcutPaths) {
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $executable
  $shortcut.Arguments = ""
  $shortcut.WorkingDirectory = $appDirectory
  $shortcut.IconLocation = "$executable,0"
  $shortcut.Description = "$appName v$version"
  $shortcut.Save()

  $saved = $shell.CreateShortcut($shortcutPath)
  if ($saved.TargetPath -ne $executable -or $saved.WorkingDirectory -ne $appDirectory) {
    throw "Shortcut verification failed: $shortcutPath"
  }
  $targetVersion = (Get-Item -LiteralPath $saved.TargetPath).VersionInfo.FileVersion
  if ($targetVersion -ne $version) {
    throw "Shortcut target version mismatch: expected $version, got $targetVersion"
  }
  Write-Output "Updated shortcut: $shortcutPath"
}

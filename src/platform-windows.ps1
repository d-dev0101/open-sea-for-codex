[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('discover', 'listeners')][string]$Operation,
  [int]$Port = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Independent implementation of registered-package discovery. Identity checks
# follow Codex Dream Skin (MIT), commit 6fc42df48a6a5365011f55cc349e20c038e56d1d.
# This helper only reads installation and process metadata. No launch or kill.
# Exact publisher identity verified against Microsoft's official catalog on 2026-10-24:
# https://displaycatalog.mp.microsoft.com/v7.0/products/9PLM9XGG6VKS?market=US&languages=en-us
# Do not use the catalog's numeric merchant PublisherId as the AppX PublisherId.
$expectedName = 'OpenAI.Codex'
$expectedPublisher = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'
$expectedPublisherId = '2p2nqsd0c76g0'
$expectedFamily = "$($expectedName)_$expectedPublisherId"
if ($Operation -eq 'discover') {
  $installs = @()
  foreach ($package in @(Get-AppxPackage -Name $expectedName | Sort-Object Version -Descending)) {
    if ($package.Name -cne $expectedName -or "$($package.SignatureKind)" -cne 'Store' -or
        [bool]$package.IsDevelopmentMode -or "$($package.Status)" -cne 'Ok' -or
        "$($package.Publisher)" -cne $expectedPublisher -or "$($package.PublisherId)" -cne $expectedPublisherId -or
        "$($package.PackageFamilyName)" -cne $expectedFamily -or -not $package.InstallLocation) { continue }
    $version = "$($package.Version)"
    $architecture = "$($package.Architecture)".ToLowerInvariant()
    if ($architecture -cnotin @('x64', 'arm64') -or "$($package.ResourceId)" -cne '' -or
        $version -cnotmatch '^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}$' -or
        @($version.Split('.') | Where-Object { [int]$_ -gt 65535 }).Count -ne 0 -or
        "$($package.PackageFullName)" -cne "$($expectedName)_$($version)_$($architecture)__$expectedPublisherId") { continue }
    $root = [IO.Path]::GetFullPath($package.InstallLocation)
    $executable = Join-Path $root 'app\ChatGPT.exe'
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { continue }
    if (((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ((Get-Item -LiteralPath (Join-Path $root 'app')).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ((Get-Item -LiteralPath $executable).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    $manifest = Get-AppxPackageManifest -Package $package
    $manifestIdentity = $manifest.Package.Identity
    if ("$($manifestIdentity.Name)" -cne $expectedName -or "$($manifestIdentity.Publisher)" -cne $expectedPublisher -or
        "$($manifestIdentity.Version)" -cne $version -or "$($manifestIdentity.ProcessorArchitecture)" -ine $architecture -or
        "$($manifestIdentity.ResourceId)" -cne '') { continue }
    $apps = @($manifest.Package.Applications.Application | Where-Object {
      "$($_.Executable)".Replace('/', '\') -ieq 'app\ChatGPT.exe'
    })
    if ($apps.Count -ne 1) { continue }
    $family = "$($package.PackageFamilyName)"
    $appId = "$($apps[0].Id)"
    if ($family -cnotmatch '^[A-Za-z0-9._-]{1,128}$' -or $appId -cnotmatch '^[A-Za-z0-9._-]{1,64}$') { continue }
    $installs += [pscustomobject]@{
      platform = 'win32'; bundlePath = $root; executable = $executable; version = "$($package.Version)"
      identity = [pscustomobject]@{
        name = $expectedName; signatureKind = 'Store'; isDevelopmentMode = $false; status = 'Ok'
        publisherId = $expectedPublisherId; architecture = $architecture
        packageFullName = "$($package.PackageFullName)"; packageFamilyName = $family
        applicationId = $appId; appUserModelId = "$family!$appId"; publisher = "$($package.Publisher)"
      }
    }
  }
  ConvertTo-Json -InputObject @($installs) -Depth 5 -Compress
  exit 0
}

if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid debugging port.' }
$listeners = @()
$processes = @{}
foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
  $listenerPid = [int]$connection.OwningProcess
  $listeners += [pscustomobject]@{ pid = $listenerPid; address = "$($connection.LocalAddress)"; port = [int]$connection.LocalPort }
  $currentPid = $listenerPid
  for ($depth = 0; $depth -lt 32 -and $currentPid -gt 0; $depth++) {
    if ($processes.ContainsKey($currentPid)) { break }
    $item = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction Stop
    if (-not $item -or -not $item.ExecutablePath) { break }
    $processes[$currentPid] = [pscustomobject]@{
      pid = [int]$item.ProcessId; parentPid = [int]$item.ParentProcessId
      executable = [IO.Path]::GetFullPath($item.ExecutablePath)
    }
    $currentPid = [int]$item.ParentProcessId
  }
}
ConvertTo-Json -InputObject ([pscustomobject]@{ listeners = @($listeners); processes = @($processes.Values) }) -Depth 5 -Compress

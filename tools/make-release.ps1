<#
    Bumps the version and regenerates update.json from what is actually on disk,
    so the file list can never drift out of sync with the extension.

    Usage:
        .\tools\make-release.ps1 -Version 1.2.0 -Notes "Fixed X","Added Y"

    Then commit and push. The extension checks update.json on the default
    branch and offers the new version.
#>
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string[]]$Notes = @()
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must look like 1.2.0 (got '$Version')."
}

# --- run the tests ----------------------------------------------------------
Write-Host 'Running tests...'
# Discovered, not listed. A hardcoded list silently stops covering the newest
# test - which is always the one guarding the newest mistake. This matches
# what .github/workflows/tests.yml runs, so a release cannot pass here and
# fail there.
$tests = Get-ChildItem -Path $PSScriptRoot -Filter 'test-*.js' -File | Sort-Object Name
if (-not $tests) { throw 'No tests found in tools/ - releasing blind is not a release.' }
foreach ($test in $tests) {
    & node $test.FullName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$($test.Name) failed - fix it before releasing." }
    Write-Host "  ok  $($test.Name)"
}

# --- update manifest.json ---------------------------------------------------
# Edited as text, not round-tripped through ConvertTo-Json: that reformats the
# whole file and can collapse single-element arrays, which would quietly break
# the manifest.
$manifestPath = Join-Path $root 'manifest.json'
$raw = [System.IO.File]::ReadAllText($manifestPath)
$pattern = '(?m)^(\s*"version"\s*:\s*)"[^"]*"'
if ($raw -notmatch $pattern) { throw 'Could not find a "version" line in manifest.json.' }
$old = ([regex]::Match($raw, '"version"\s*:\s*"([^"]*)"')).Groups[1].Value
$raw = [regex]::Replace($raw, $pattern, "`${1}""$Version""", 1)
[System.IO.File]::WriteAllText($manifestPath, $raw, (New-Object System.Text.UTF8Encoding $false))

# Prove we did not corrupt it.
$check = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($check.version -ne $Version) { throw "manifest.json version did not take." }
if (-not $check.content_scripts -or $check.content_scripts.Count -lt 2) {
    throw 'manifest.json lost its content_scripts — restore it from git.'
}
# Refusing an unchanged version is not pedantry.
#
# checkUpdate() compares version numbers and nothing else, so shipping
# changes under a version already in the wild means no machine is ever
# offered them - silently. Re-running this with the same number also
# rewrites update.json's notes, which is how a real release note gets
# replaced by whatever was typed to test the script.
if ($old -eq $Version) {
    throw "manifest.json is already at $Version. Never ship changes on an unchanged version number."
}

Write-Host "manifest.json: $old -> $Version"

# --- collect the files that make up the extension ---------------------------
# docs and tools live in the repo but are not part of the installed extension —
# the updater fetches every file listed here, so shipping them would make each
# update download design notes for no reason.
# Kept in step with SKIP_DIRS/SKIP_FILES in tools/test-release-consistency.js
# and the exclude list in .github/workflows/tests.yml. Those three disagreeing
# is how a genuinely shipped file ends up exempt from every check there is.
$skip = @('tools', 'docs', '.git', '.github', 'node_modules')
# Developer notes, not runtime code. Shipping CLAUDE.md would write it onto
# every machine on every update, for nothing.
$skipFiles = @('CLAUDE.md')
$files = Get-ChildItem -Path $root -Recurse -File |
    Where-Object {
        $rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
        $top = $rel.Split('/')[0]
        # A leading dot means repo scaffolding: .gitattributes, .gitignore.
        ($skip -notcontains $top) -and ($skipFiles -notcontains $rel) -and (-not $top.StartsWith('.'))
    } |
    ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') } |
    Sort-Object

# --- write update.json ------------------------------------------------------
$updatePath = Join-Path $root 'update.json'
$json = [ordered]@{
    version = $Version
    notes   = @($Notes)
    files   = @($files)
} | ConvertTo-Json -Depth 20
# ConvertTo-Json collapses a one-element array to a scalar; the updater needs
# real arrays.
if ($Notes.Count -eq 1) { $json = $json -replace '("notes"\s*:\s*)("(?:[^"\\]|\\.)*")', '$1[$2]' }
[System.IO.File]::WriteAllText($updatePath, $json, (New-Object System.Text.UTF8Encoding $false))

$verify = Get-Content $updatePath -Raw | ConvertFrom-Json
if (@($verify.files).Count -ne $files.Count) { throw 'update.json file list did not round-trip.' }

Write-Host "update.json lists $($files.Count) files:"
$files | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Now: git add -A; git commit -m 'v$Version'; git push"

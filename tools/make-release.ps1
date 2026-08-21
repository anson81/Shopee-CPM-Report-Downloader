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

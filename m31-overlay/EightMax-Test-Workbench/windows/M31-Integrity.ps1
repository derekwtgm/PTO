<# EightMax Test Workbench 0.36.2 Milestone 3.1 - release integrity in PowerShell (the same rules as tools/release-integrity.cjs; this one
   needs no Node.js because it also verifies the bundled node.exe). Dot-source after M31-Lib.ps1.

   The immutable payload is defined by release-integrity-policy.json, used only after SHA256SUMS.txt has verified it:
     FAIL     a listed file missing or changed; a malformed / unsafe / duplicate manifest line; an executable or script that SHA256SUMS.txt
              does not list anywhere in the payload; a link (junction / symlink) inside the payload (never followed)
     WARNING  another unlisted file inside the payload (named); an unrecognised executable in the runtime output folder; a link there
     IGNORED  runtime output (test-results\), operating-system metadata (Thumbs.db, desktop.ini, .DS_Store), development metadata (.git)
   Milestone 3 failed on the operator PC because its check walked the whole folder, including the runner's own test-results\ output. #>

function Get-M31ManifestEntries([string]$Root) {
    $res = [ordered]@{ entries = (New-Object Collections.ArrayList); malformed = (New-Object Collections.ArrayList); unsafe = (New-Object Collections.ArrayList); duplicates = (New-Object Collections.ArrayList) }
    $cmp = $(if ($script:M31IsWindows) { [StringComparer]::OrdinalIgnoreCase } else { [StringComparer]::Ordinal })
    $seen = New-Object 'Collections.Generic.HashSet[string]' ($cmp)
    $text = [IO.File]::ReadAllText((Join-Path $Root 'SHA256SUMS.txt'), $script:M31Utf8)
    $n = 0
    foreach ($line in ($text -split "`r?`n")) {
        $n++
        if (-not $line.Trim()) { continue }
        $m = [regex]::Match($line, '^([0-9a-f]{64}) {2}(.+)$')
        if (-not $m.Success) { [void]$res.malformed.Add([ordered]@{ line = $n; text = $line.Substring(0, [math]::Min(200, $line.Length)) }); continue }
        $rel = $m.Groups[2].Value
        $parts = $rel -split '/'
        if ($rel.Contains('\') -or $rel.StartsWith('/') -or $rel -match '^[A-Za-z]:' -or @($parts | Where-Object { $_ -eq '..' -or $_ -eq '.' -or $_ -eq '' }).Count -or $rel -match '[\x00-\x1f]') { [void]$res.unsafe.Add([ordered]@{ line = $n; path = $rel }); continue }
        if (-not $seen.Add($rel)) { [void]$res.duplicates.Add($rel); continue }
        [void]$res.entries.Add([ordered]@{ sha256 = $m.Groups[1].Value; path = $rel })
    }
    return $res
}
function Get-M31PolicyClass([string]$Rel, $Policy) {
    $parts = $Rel -split '/'; $top = $parts[0]; $name = $parts[$parts.Count - 1]
    $eq = { param($a, $b) if ($script:M31IsWindows) { return [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase) } else { return $a -ceq $b } }
    foreach ($d in @($Policy.developmentMetadataFolders)) { if (& $eq $d $top) { return 'development' } }
    foreach ($f in @($Policy.operatingSystemMetadataFiles)) { if (& $eq $f $name) { return 'os-metadata' } }
    if ($parts.Count -gt 1) { foreach ($d in @($Policy.runtimeOutputFolders)) { if (& $eq $d $top) { return 'runtime-output' } } }
    return 'payload'
}
function Test-M31ExecutableName([string]$Rel, $Policy) {
    $ext = [IO.Path]::GetExtension($Rel).ToLowerInvariant()
    return ($ext -and (@($Policy.executableExtensions) -contains $ext))
}
function Get-M31KnownRuntimeExecutable([string]$Root, [string]$Rel, $Policy) {
    foreach ($k in @($Policy.knownRuntimeExecutables)) {
        $opt = $(if ($script:M31IsWindows) { [Text.RegularExpressions.RegexOptions]::IgnoreCase } else { [Text.RegularExpressions.RegexOptions]::None })
        if (-not [regex]::IsMatch($Rel, [string]$k.pattern, $opt)) { continue }
        try {
            $dir = [IO.Path]::GetDirectoryName((Join-Path $Root ($Rel -replace '/', [string][IO.Path]::DirectorySeparatorChar)))
            $want = ([IO.File]::ReadAllText((Join-Path $dir ([string]$k.verifiedBy)))).Trim().ToLowerInvariant()
            if ($want -match '^[0-9a-f]{64}$' -and $want -eq (Get-M31Sha256 (Join-Path $Root ($Rel -replace '/', [string][IO.Path]::DirectorySeparatorChar)))) { return [string]$k.id }
        } catch {}
    }
    return $null
}
function Get-M31TreeEntries([string]$Root) {
    # every file (relative, '/') and every link (never followed) below $Root
    $files = New-Object Collections.ArrayList; $links = New-Object Collections.ArrayList; $unreadable = New-Object Collections.ArrayList
    $stack = New-Object Collections.Stack; $stack.Push((New-Object IO.DirectoryInfo($Root)))
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    while ($stack.Count) {
        $d = $stack.Pop()
        $items = $null
        try { $items = @($d.GetFileSystemInfos()) } catch { [void]$unreadable.Add([ordered]@{ path = (Get-M31RelativePath $d.FullName $rootFull); error = $_.Exception.Message }); continue }
        foreach ($i in $items) {
            $rel = Get-M31RelativePath $i.FullName $rootFull
            if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { [void]$links.Add($rel); continue }
            if ($i -is [IO.DirectoryInfo]) { $stack.Push($i) } else { [void]$files.Add($rel) }
        }
    }
    return [ordered]@{ files = $files.ToArray(); links = $links.ToArray(); unreadable = $unreadable.ToArray() }
}
function Test-M31ReleaseIntegrity([string]$Root, $Policy = $null, [switch]$SkipHashes) {
    $res = [ordered]@{
        format = 'eightmax-release-integrity'; version = 1; root = $Root; checkedAt = (Get-M31Now); ok = $false
        manifest = [ordered]@{ file = 'SHA256SUMS.txt'; entries = 0; malformed = @(); unsafe = @(); duplicates = @() }
        verified = 0; missing = (New-Object Collections.ArrayList); modified = (New-Object Collections.ArrayList); unexpectedExecutables = (New-Object Collections.ArrayList); unexpectedOther = (New-Object Collections.ArrayList); payloadLinks = (New-Object Collections.ArrayList)
        runtimeOutput = [ordered]@{ folders = @(); files = 0; knownExecutables = (New-Object Collections.ArrayList); unrecognisedExecutables = (New-Object Collections.ArrayList); links = (New-Object Collections.ArrayList) }
        ignored = [ordered]@{ osMetadata = (New-Object Collections.ArrayList); development = 0 }; unreadable = (New-Object Collections.ArrayList)
        failures = (New-Object Collections.ArrayList); warnings = (New-Object Collections.ArrayList); policy = $null; seconds = $null
    }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $fail = { param($c, $m) [void]$res.failures.Add([ordered]@{ code = $c; message = $m }) }
    $warn = { param($c, $m) [void]$res.warnings.Add([ordered]@{ code = $c; message = $m }) }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'SHA256SUMS.txt') -PathType Leaf)) { & $fail 'manifest-missing' 'SHA256SUMS.txt is missing: extract the complete ZIP again'; $res.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); return $res }
    $man = Get-M31ManifestEntries $Root
    $res.manifest.entries = $man.entries.Count; $res.manifest.malformed = $man.malformed.ToArray(); $res.manifest.unsafe = $man.unsafe.ToArray(); $res.manifest.duplicates = $man.duplicates.ToArray()
    if (-not $man.entries.Count) { & $fail 'manifest-empty' 'SHA256SUMS.txt lists no release files' }
    foreach ($x in $man.malformed) { & $fail 'manifest-malformed' ('SHA256SUMS.txt line ' + [string]$x.line + ' is not "<sha256>  <path>"') }
    foreach ($x in $man.unsafe) { & $fail 'manifest-unsafe-path' ('SHA256SUMS.txt line ' + [string]$x.line + ' names a path outside the release: ' + [string]$x.path) }
    foreach ($x in $man.duplicates) { & $fail 'manifest-duplicate' ('SHA256SUMS.txt lists ' + [string]$x + ' twice') }
    $cmp = $(if ($script:M31IsWindows) { [StringComparer]::OrdinalIgnoreCase } else { [StringComparer]::Ordinal })
    $listed = New-Object 'Collections.Generic.HashSet[string]' ($cmp)
    $policyEntry = $null
    foreach ($e in $man.entries) {
        [void]$listed.Add([string]$e.path)
        if ($cmp.Equals([string]$e.path, 'release-integrity-policy.json')) { $policyEntry = $e }
        $full = Join-Path $Root ([string]$e.path -replace '/', [string][IO.Path]::DirectorySeparatorChar)
        if (-not [IO.File]::Exists($full)) { [void]$res.missing.Add([string]$e.path); & $fail 'missing' ([string]$e.path + ' is listed in SHA256SUMS.txt but missing'); continue }
        if ($SkipHashes) { continue }
        $h = $null; try { $h = Get-M31Sha256 $full } catch { [void]$res.unreadable.Add([ordered]@{ path = [string]$e.path; error = $_.Exception.Message }); & $fail 'unreadable' ([string]$e.path + ' cannot be read: ' + $_.Exception.Message); continue }
        if ($h -ne [string]$e.sha256) { [void]$res.modified.Add([string]$e.path); & $fail 'modified' ([string]$e.path + ' differs from its release checksum') } else { $res.verified++ }
    }
    if (-not $Policy) {
        if (-not $policyEntry) { & $fail 'policy-unlisted' 'release-integrity-policy.json is not listed in SHA256SUMS.txt' }
        elseif ($res.missing -contains $policyEntry.path -or $res.modified -contains $policyEntry.path) { }
        else { try { $Policy = Read-M31JsonFile (Join-Path $Root 'release-integrity-policy.json') } catch { & $fail 'policy-unreadable' ('release-integrity-policy.json cannot be parsed: ' + $_.Exception.Message) } }
    }
    if ($Policy) {
        $res.policy = [ordered]@{ file = 'release-integrity-policy.json'; version = $Policy.version; runtimeOutputFolders = @($Policy.runtimeOutputFolders) }
        $tree = Get-M31TreeEntries $Root
        foreach ($u in $tree.unreadable) { [void]$res.unreadable.Add($u); & $fail 'unreadable-folder' ('folder ' + [string]$u.path + ' cannot be listed: ' + [string]$u.error) }
        $folders = New-Object Collections.ArrayList
        foreach ($rel in $tree.files) {
            if ($cmp.Equals($rel, 'SHA256SUMS.txt')) { continue }
            $c = Get-M31PolicyClass $rel $Policy
            if ($c -eq 'development') { $res.ignored.development++; continue }
            if ($c -eq 'os-metadata') { [void]$res.ignored.osMetadata.Add($rel); continue }
            if ($c -eq 'runtime-output') {
                $res.runtimeOutput.files++; $top2 = (($rel -split '/') | Select-Object -First 2) -join '/'; if (-not ($folders -contains $top2)) { [void]$folders.Add($top2) }
                if (Test-M31ExecutableName $rel $Policy) {
                    $k = Get-M31KnownRuntimeExecutable $Root $rel $Policy
                    if ($k) { [void]$res.runtimeOutput.knownExecutables.Add([ordered]@{ path = $rel; kind = $k }) }
                    else { [void]$res.runtimeOutput.unrecognisedExecutables.Add($rel); & $warn 'runtime-output-executable' ('unrecognised executable in the runtime output folder (not part of the release, never run by it): ' + $rel) }
                }
                continue
            }
            if ($listed.Contains($rel)) { continue }
            if (Test-M31ExecutableName $rel $Policy) { [void]$res.unexpectedExecutables.Add($rel); & $fail 'unexpected-executable' ('executable or script not in the release manifest: ' + $rel) }
            else { [void]$res.unexpectedOther.Add($rel); & $warn 'unexpected-file' ('file not in the release manifest (not an executable): ' + $rel) }
        }
        foreach ($rel in $tree.links) {
            $c = Get-M31PolicyClass $rel $Policy
            if ($c -eq 'development' -or $c -eq 'os-metadata') { continue }
            if ($c -eq 'runtime-output') { [void]$res.runtimeOutput.links.Add($rel); & $warn 'runtime-output-link' ('link in the runtime output folder (not followed): ' + $rel) }
            else { [void]$res.payloadLinks.Add($rel); & $fail 'payload-link' ('link inside the release payload (not followed): ' + $rel) }
        }
        $res.runtimeOutput.folders = @($folders | Sort-Object)
    }
    $res.ok = ($res.failures.Count -eq 0)
    $res.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    return $res
}
function Format-M31IntegritySummary($R) {
    return ($(if ($R.ok) { 'PASS' } else { 'FAIL' }) + ': ' + [string]$R.verified + ' of ' + [string]$R.manifest.entries + ' listed files verified; missing ' + [string]@($R.missing).Count + ', modified ' + [string]@($R.modified).Count +
        ', unexpected executables ' + [string]@($R.unexpectedExecutables).Count + ', other unlisted files ' + [string]@($R.unexpectedOther).Count + '; runtime output ignored: ' + [string]$R.runtimeOutput.files +
        ' file(s) in ' + [string]@($R.runtimeOutput.folders).Count + ' folder(s); warnings ' + [string]@($R.warnings).Count)
}

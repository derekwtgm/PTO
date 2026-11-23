param([switch]$BuildOnly,[switch]$Headless,[string]$ReadyFile,[switch]$ForceCompile,[string]$CacheRoot,[string]$StatusFile,[string]$TraceFile)
# EightMax Test Workbench - start the desktop host (desktop\bin\EightMaxWorkbench.exe), or compile it from the shipped source when the
# prebuilt host cannot start.
# 0.36.2 Milestone 3: the fallback compile now uses EVERY source of the host - DesktopHost.cs, CaptureService.cs AND InputBroker.cs (until
# Milestone 2 InputBroker.cs was missing, so the fallback could never compile) - with the options of windows\Build-Executables.ps1
# (/main, /langversion:5, x64, winexe, optimize). The cache folder is named after a fingerprint of the cache format, the compiler options,
# the referenced assemblies, the .NET runtime and the SHA-256 of every source, and a cache-manifest.json inside it is checked before the
# cached executable is reused: a changed source, option or runtime can never reuse an older executable. A cached executable whose hash
# or manifest does not match is discarded and rebuilt. -CacheRoot (tests) moves the cache; -StatusFile writes what happened as JSON.
# The release check (SHA256SUMS.txt) still runs first and is never skipped.
# 0.36.2 Milestone 3.1: on the operator's PC the Milestone 3 host-start test stopped inside this script (it never exited; the runner waited
# up to 15 minutes per case without any output). -TraceFile (tests) writes one JSON line before and after every step, so a stop is located
# exactly. Headless (test) launches use CreateProcess with the host's own stdout/stderr captured beside the ready file: a plain
# Start-Process uses the Windows shell, which can wait for an answer to a security prompt (downloaded, unsigned program) that nobody sees
# during an unattended test; the headless host also reports its start-up errors only on stderr, which was discarded. The interactive launch
# (START-DESKTOP.cmd, no -Headless) is unchanged.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
$root=Get-WorkbenchRoot
$CacheFormat='eightmax-desktop-cache-v2'
# The host's sources, in compile order. Must equal windows\Build-Executables.ps1 and desktop\COMPONENT-VERSIONS.json (checked by tests).
$HostSources=@('desktop\DesktopHost.cs','desktop\CaptureService.cs','desktop\InputBroker.cs')
$HostMain='EightMax.Workbench.DesktopHost'
$CompilerOptions='/target:winexe /platform:x64 /optimize+ /langversion:5 /main:'+$HostMain
$status=[ordered]@{ format='eightmax-desktop-start'; version=1; at=[DateTime]::UtcNow.ToString('o'); path=$null; cacheFolder=$null; fingerprint=$null; sources=@(); compiled=$false; reusedCache=$false; invalidCache=$null; exe=$null; exeSha256=$null; launched=$false; pid=$null; launchMethod=$null; hostStdout=$null; hostStderr=$null; error=$null }
# The status record is written with ConvertTo-Json (PowerShell-native: values created by PowerShell serialise reliably; JavaScriptSerializer
# failed on this record on Windows PowerShell 5.1 in CI run 45181140222). If even that fails, a minimal record is written - never nothing.
function Write-StartStatus { if($StatusFile){ try{ Write-WorkbenchUtf8 $StatusFile (ConvertTo-Json -InputObject $status -Depth 6 -Compress) }catch{ Write-Warning ('Start-Desktop status record: '+$_.Exception.Message); try{ $e=([string]$status.error) -replace '[\\"]',' '; Write-WorkbenchUtf8 $StatusFile ('{"format":"eightmax-desktop-start","version":1,"path":"'+[string]$status.path+'","launched":'+$(if($status.launched){'true'}else{'false'})+',"pid":'+$(if($status.pid){[string]$status.pid}else{'null'})+',"error":"'+$e+'","statusError":"record could not be serialised"}') }catch{} } } }
function Write-StartTrace([string]$Step,[string]$State,[string]$Detail){ if($TraceFile){ try{ $e=[ordered]@{ at=[DateTime]::UtcNow.ToString('o'); pid=$PID; step=$Step; state=$State; detail=$Detail }; [IO.File]::AppendAllText($TraceFile,(ConvertTo-Json -InputObject $e -Compress)+"`r`n",(New-Object Text.UTF8Encoding($false))) }catch{} } }
Write-StartTrace 'script' 'start' ('PowerShell '+$PSVersionTable.PSVersion.ToString()+'; 64-bit process '+[Environment]::Is64BitProcess+'; headless '+[bool]$Headless+'; build-only '+[bool]$BuildOnly+'; force-compile '+[bool]$ForceCompile)
function Get-Sha([string]$Path){ return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-TextSha([string]$Text){ $h=[Security.Cryptography.SHA256]::Create(); try{ return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))) -replace '-','').ToLowerInvariant() } finally { $h.Dispose() } }
try {
    Add-Type -AssemblyName System.Web.Extensions
    if(-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess){throw 'Use 64-bit Windows PowerShell to launch the desktop host.'}
    Write-StartTrace 'release-verification' 'start' (Join-Path $root 'SHA256SUMS.txt')
    $failures=@(Get-WorkbenchHashFailures $root);if($failures.Count){Write-StartTrace 'release-verification' 'fail' (($failures|Select-Object -First 5)-join '; ');throw ('Release verification failed: '+(($failures|Select-Object -First 5)-join '; '))}
    Write-StartTrace 'release-verification' 'end' 'every listed file matches'
    # Fingerprint of everything that determines the compiled executable.
    $sourceList=@()
    foreach($rel in $HostSources){
        $full=Join-Path $root $rel
        if(-not (Test-Path -LiteralPath $full -PathType Leaf)){throw ('Desktop host source missing: '+$rel)}
        $sourceList+=[ordered]@{ path=($rel -replace '\\','/'); sha256=(Get-Sha $full) }
    }
    Add-Type -AssemblyName Microsoft.CSharp,System.Windows.Forms,System.Drawing
    $references=@([System.Uri].Assembly.Location,[System.Linq.Enumerable].Assembly.Location,[System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,[System.Windows.Forms.Form].Assembly.Location,[System.Drawing.Point].Assembly.Location)
    $refNames=@($references|ForEach-Object { [IO.Path]::GetFileName($_)+' '+[Diagnostics.FileVersionInfo]::GetVersionInfo($_).FileVersion })
    $identity=$CacheFormat+"`n"+$CompilerOptions+"`n"+($refNames -join '|')+"`n"+[Environment]::Version.ToString()+"`n"+(($sourceList|ForEach-Object { $_.path+':'+$_.sha256 }) -join "`n")
    $fingerprint=Get-TextSha $identity
    $status.fingerprint=$fingerprint; $status.sources=$sourceList; Write-StartTrace 'fingerprint' 'end' $fingerprint
    if(-not $CacheRoot){$CacheRoot=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'EightMax-Test-Workbench\DesktopCache'}
    $cache=Join-Path $CacheRoot $fingerprint; $status.cacheFolder=$cache
    [IO.Directory]::CreateDirectory($cache)|Out-Null
    $exe=Join-Path $cache 'EightMaxWorkbench.exe';$stamp=Join-Path $cache 'compiler-output.sha256';$manifest=Join-Path $cache 'cache-manifest.json'
    # 0.19: prefer the prebuilt, manifest-verified host (no compile on first launch); fall back to compiling the shipped source.
    $prebuilt=Join-Path $root 'desktop\bin\EightMaxWorkbench.exe'
    $usePrebuilt=(-not $ForceCompile) -and (-not $BuildOnly) -and (Test-Path -LiteralPath $prebuilt -PathType Leaf)
    if($usePrebuilt){$rebuild=$false;$exe=$prebuilt;$status.path='prebuilt'}else{
        # A cached executable is reused only when it exists, its hash equals the recorded compiler output, and the cache manifest
        # describes exactly the current fingerprint and sources. Anything else is an invalid cache: discarded and rebuilt.
        $why=$null
        if(-not (Test-Path -LiteralPath $exe -PathType Leaf)){$why='no cached executable'}
        elseif(-not (Test-Path -LiteralPath $stamp -PathType Leaf)){$why='compiler-output.sha256 missing'}
        elseif((Get-Sha $exe) -ne [IO.File]::ReadAllText($stamp).Trim()){$why='cached executable does not match its recorded hash'}
        elseif(-not (Test-Path -LiteralPath $manifest -PathType Leaf)){$why='cache-manifest.json missing'}
        else{
            try{ $m=(New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText($manifest)) }catch{ $m=$null }
            if(-not $m -or $m['format'] -ne $CacheFormat -or $m['fingerprint'] -ne $fingerprint){$why='cache manifest does not describe the current sources'}
            else{ $ms=@($m['sources']|ForEach-Object { [string]$_['path']+':'+[string]$_['sha256'] }) -join '|'; $cs=@($sourceList|ForEach-Object { $_.path+':'+$_.sha256 }) -join '|'; if($ms -ne $cs){$why='cache manifest sources differ'} }
        }
        $rebuild=[bool]$why
        if($rebuild -and (Test-Path -LiteralPath $exe -PathType Leaf)){ $status.invalidCache=$why; try{Remove-Item -LiteralPath $exe -Force}catch{throw ('The invalid cached host could not be removed ('+$why+'): '+$_.Exception.Message)} }
        if($rebuild){$status.path='compiled'}else{$status.path='cache';$status.reusedCache=$true}
        Write-StartTrace 'cache-check' 'end' ('path '+$status.path+$(if($why){', reason: '+$why}else{''}))
    }
    if($rebuild){
        Write-StartTrace 'compile' 'start' ($HostSources -join ', ')
        $temp=Join-Path $cache ('build-'+[guid]::NewGuid().ToString('N')+'.exe')
        $provider=New-Object Microsoft.CSharp.CSharpCodeProvider
        $parameters=New-Object System.CodeDom.Compiler.CompilerParameters
        $parameters.GenerateExecutable=$true;$parameters.GenerateInMemory=$false;$parameters.OutputAssembly=$temp
        $parameters.CompilerOptions=$CompilerOptions
        foreach($assembly in $references){$null=$parameters.ReferencedAssemblies.Add($assembly)}
        $texts=[string[]]@($HostSources|ForEach-Object { [IO.File]::ReadAllText((Join-Path $root $_)) })
        try{$compiled=$provider.CompileAssemblyFromSource($parameters,$texts);if($compiled.Errors.HasErrors){throw (($compiled.Errors|ForEach-Object {$_.ToString()}) -join "`n")}}finally{$provider.Dispose()}
        Copy-Item -LiteralPath $temp -Destination $exe -Force
        try{Remove-Item -LiteralPath $temp -Force}catch{}
        try{Remove-Item -LiteralPath ([IO.Path]::ChangeExtension($temp,'.pdb')) -Force -ErrorAction SilentlyContinue}catch{}
        $exeHash=Get-Sha $exe
        Write-WorkbenchUtf8 $stamp $exeHash
        $doc=[ordered]@{ format=$CacheFormat; fingerprint=$fingerprint; compilerOptions=$CompilerOptions; references=$refNames; runtime=[Environment]::Version.ToString(); sources=$sourceList; exeSha256=$exeHash; compiledAt=[DateTime]::UtcNow.ToString('o'); appVersion=$WorkbenchVersion }
        Write-WorkbenchUtf8 $manifest ((New-Object Web.Script.Serialization.JavaScriptSerializer).Serialize($doc))
        $status.compiled=$true; Write-StartTrace 'compile' 'end' ('sha256 '+$exeHash)
    }
    $status.exe=$exe; $status.exeSha256=(Get-Sha $exe)
    if($BuildOnly){Write-StartStatus;Write-StartTrace 'script' 'end' 'build-only: exit 0';Write-Output $exe;exit 0}
    if(-not $ReadyFile){$session=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('EightMax-Test-Workbench\DesktopSessions\'+[guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($session)|Out-Null;$ReadyFile=Join-Path $session 'session.json'}
    $launchArgs='--root '+(Quote-WorkbenchPath $root)+' --ready '+(Quote-WorkbenchPath ([IO.Path]::GetFullPath($ReadyFile)));if($Headless){$launchArgs+=' --headless'}
    # The fallback is the same script with -ForceCompile; -Headless, -CacheRoot and -StatusFile are passed on (until Milestone 2 -Headless was dropped).
    $fallbackArgs=@{ ForceCompile=$true; ReadyFile=$ReadyFile; Headless=[bool]$Headless }; if($CacheRoot){$fallbackArgs.CacheRoot=$CacheRoot}; if($StatusFile){$fallbackArgs.StatusFile=$StatusFile}; if($TraceFile){$fallbackArgs.TraceFile=$TraceFile}
    $startArgs=@{ FilePath=$exe; ArgumentList=$launchArgs; PassThru=$true }
    if($Headless){
        # test launch: CreateProcess (Start-Process with redirection never uses the shell), the host's stdout/stderr beside the ready file
        $hostLog=Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReadyFile))) ([IO.Path]::GetFileNameWithoutExtension($ReadyFile))
        $startArgs.WorkingDirectory=$root; $startArgs.RedirectStandardOutput=$hostLog+'.host-stdout.txt'; $startArgs.RedirectStandardError=$hostLog+'.host-stderr.txt'; $startArgs.WindowStyle='Hidden'
        $status.launchMethod='CreateProcess'; $status.hostStdout=$startArgs.RedirectStandardOutput; $status.hostStderr=$startArgs.RedirectStandardError
    } else { $status.launchMethod='ShellExecute' }
    Write-StartTrace 'launch-host' 'start' ($status.launchMethod+': '+$exe)
    try{$launched=Start-Process @startArgs}
    catch{
        Write-StartTrace 'launch-host' 'fail' $_.Exception.Message
        if($usePrebuilt){Write-Warning ('Prebuilt host could not start ('+$_.Exception.Message+'); compiling from source instead.');& $PSCommandPath @fallbackArgs;exit $LASTEXITCODE}
        throw
    }
    if($usePrebuilt -and -not $Headless){
        # A host that stays alive but never writes its ready file is treated as unusable; one that exits on its own has already shown its own error.
        $deadline=(Get-Date).AddSeconds(20);$ready=$false
        while((Get-Date) -lt $deadline){if(Test-Path -LiteralPath $ReadyFile){$ready=$true;break};if($launched.HasExited){$ready=$true;break};Start-Sleep -Milliseconds 250}
        if(-not $ready){
            try{if(-not $launched.HasExited){$launched.Kill()}}catch{}
            Write-Warning 'Prebuilt host did not become ready within 20 seconds; compiling from source instead.'
            & $PSCommandPath @fallbackArgs;exit $LASTEXITCODE
        }
    }
    Write-StartTrace 'launch-host' 'end' ('pid '+$launched.Id)
    $status.launched=$true; $status.pid=$launched.Id; Write-StartStatus
    Write-StartTrace 'script' 'end' 'host launched: exit 0'
    $launched.Id
} catch {
    $status.error=$_.Exception.Message; Write-StartStatus
    Write-StartTrace 'script' 'error' ($_.Exception.GetType().FullName+': '+$_.Exception.Message+' (line '+$_.InvocationInfo.ScriptLineNumber+')')
    if($Headless -or $BuildOnly){Write-Error $_.Exception.Message;exit 1}
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message+"`n`nNo extra runtime is downloaded. You can use START.html and the manual native job runner while this Windows build is checked.",'EightMax desktop could not start','OK','Error')|Out-Null
    exit 1
}

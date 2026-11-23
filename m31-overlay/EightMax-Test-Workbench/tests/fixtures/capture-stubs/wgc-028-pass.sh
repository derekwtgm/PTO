#!/bin/sh
# Emits the 0.28.0 EightMaxWgc.exe protocol for harness tests only (no capture happens).
case "$1" in
  --version) echo '{"tool":"EightMaxWgc","version":"0.28.0","backend":"windows-graphics-capture","os":"stub"}' ;;
  --probe) echo '{"ok":true,"tool":"EightMaxWgc","version":"0.28.0","backend":"windows-graphics-capture","supported":true,"os":"stub","detail":""}' ;;
  --selftest)
    s=""; for st in create-window session-start first-frame verify-original-pixels resize-detected verify-resized-pixels refuse-wrong-process detect-minimized recover-after-restore frame-sequence repeated-sessions-and-cleanup detect-closed refuse-closed-handle; do s="$s{\"stage\":\"$st\",\"status\":\"pass\",\"detail\":\"ok\",\"ms\":1},"; done
    printf '{"format":"eightmax-wgc-selftest","version":1,"toolVersion":"0.28.0","os":"stub","stages":[%s],"missingStages":[],"failures":0,"harnessErrors":0,"passed":true,"durationMs":5}' "${s%,}" > "$3/wgc-selftest-result.json"; cat "$3/wgc-selftest-result.json" ;;
  --hwnd) echo '{"ok":false,"backend":"windows-graphics-capture","code":"target-lost","reason":"The window no longer exists."}'; exit 1 ;;
  *) echo '{"ok":false,"backend":"windows-graphics-capture","code":"bad-arguments","reason":"Unknown argument"}'; exit 2 ;;
esac

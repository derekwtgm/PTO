#!/bin/sh
# Emits the 0.28.0 self-test protocol (stage lines + selftest-result.json) for harness tests. Not a capture implementation.
case "$1" in
  version) echo '{"tool":"EightMaxCapture","version":"0.28.0","dpiAwareness":"per-monitor-v2 (this thread)"}' ;;
  list-monitors) echo '{"format":"eightmax-capture-monitors","version":1,"virtual":{"x":0,"y":0,"width":3840,"height":2160},"monitors":[{"id":0,"name":"D1","x":0,"y":0,"width":3840,"height":2160,"dpiScale":1.5,"primary":true}]}' ;;
  list-windows) echo '{"format":"eightmax-capture-windows","version":1,"windows":[{"hwnd":"0x1","pid":1,"title":"x"}]}' ;;
  selftest)
    s=""; for st in create-window capture-original verify-original-pixels capture-resized verify-resized-pixels detect-minimized capture-after-restore detect-closed; do echo "PASS $st"; s="$s{\"stage\":\"$st\",\"status\":\"pass\",\"detail\":\"ok\",\"ms\":1},"; done
    s=${s%,}
    printf '{"format":"eightmax-capture-selftest","version":2,"toolVersion":"0.28.0","pid":1,"dpiScale":1.5,"stages":[%s],"missingStages":[],"failures":0,"harnessErrors":0,"passed":true,"durationMs":5}' "$s" > "$2/selftest-result.json"
    echo "SELFTEST PASS" ;;
esac

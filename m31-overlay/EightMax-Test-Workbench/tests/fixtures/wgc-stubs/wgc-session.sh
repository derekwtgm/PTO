#!/bin/sh
# Fake EightMaxWgc.exe --session --emit-png for Linux tests of the host's persistent-session machinery (no capture happens).
# MODE env: normal (3 frames, then waits for "stop"), lost (1 frame, then target-lost), refuse (refuses at once).
PNG=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
echo "$$" >> "${WGC_STUB_PIDS:-/dev/null}"
case "${WGC_STUB_MODE:-normal}" in
  refuse) echo '{"ok":false,"backend":"windows-graphics-capture","code":"target-minimized","reason":"The window is minimised."}'; exit 1 ;;
esac
echo '{"event":"started","backend":"windows-graphics-capture","device":"stub","width":1,"height":1,"fps":10,"queue":2}'
n=1; last=3; [ "${WGC_STUB_MODE}" = lost ] && last=1
while [ $n -le $last ]; do sleep 0.15; echo "{\"event\":\"frame\",\"seq\":$n,\"width\":1,\"height\":1,\"systemRelativeTimeMs\":$((1000+n*100)),\"ageMs\":2,\"blank\":false,\"png\":\"$PNG\"}"; n=$((n+1)); done
if [ "${WGC_STUB_MODE}" = lost ]; then sleep 0.2; echo '{"event":"target-lost","code":"target-lost"}'; echo '{"event":"summary","end":"target-lost"}'; exit 0; fi
read line; echo '{"event":"summary","end":"stopped","delivered":3}'; exit 0

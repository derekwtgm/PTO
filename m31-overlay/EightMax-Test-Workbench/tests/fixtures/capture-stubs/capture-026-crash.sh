#!/bin/sh
# Replays the 0.26.0 EightMaxCapture.exe behaviour recorded on the target PC (Windows 11 26300, 150 %):
# monitors/windows listed, two captures and the minimised check succeed, then the tool dies reading Form.Handle after Close().
case "$1" in
  version) echo "usage: list-windows | list-monitors | capture-window | capture-region | selftest" >&2; exit 2 ;;
  list-monitors) echo '{"format":"eightmax-capture-monitors","version":1,"virtual":{"x":0,"y":0,"width":3840,"height":2160},"monitors":[{"id":0,"name":"DISPLAY1","x":0,"y":0,"width":3840,"height":2160,"dpiScale":1.5,"primary":true}]}' ;;
  list-windows) echo '{"format":"eightmax-capture-windows","version":1,"windows":[{"hwnd":"0x1","pid":1,"title":"x"}]}' ;;
  selftest)
    echo "saved $2/selftest-0.png 640x400 method=print-window dpiScale=1.5 occluded=0"
    echo "saved $2/selftest-1.png 800x500 method=print-window dpiScale=1.5 occluded=0"
    echo "minimised window correctly reported"
    echo "" >&2
    echo "Unhandled Exception: System.ObjectDisposedException: Cannot access a disposed object." >&2
    echo "Object name: 'Form'." >&2
    exit 134 ;;
esac

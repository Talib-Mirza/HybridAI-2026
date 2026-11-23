#!/bin/sh
# Renders the toolbar/store icons to extension/public/icons with headless Chrome (no extra dependencies).
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
out=../public/icons
tmp=$(mktemp -d)
render() { # svg size
  printf '<html><body style="margin:0;background:transparent"><img src="%s" width="%s" height="%s" style="display:block"></body></html>' "$PWD/$1" "$2" "$2" > "$tmp/p.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size="$2,$2" --screenshot="$PWD/$out/icon-$2.png" "file://$tmp/p.html" >/dev/null 2>&1
}
render icon-16.svg 16
render icon-32.svg 32
render icon.svg 48
render icon.svg 128
rm -rf "$tmp"
ls -l $out

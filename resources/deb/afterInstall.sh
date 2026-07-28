#!/bin/sh
set -e
RULES_SRC="/opt/GBLink Netplay Bridge/resources/70-gblink.rules"
RULES_DST="/usr/lib/udev/rules.d/70-gblink.rules"
if [ -f "$RULES_SRC" ]; then
  cp "$RULES_SRC" "$RULES_DST"
  udevadm control --reload-rules || true
  udevadm trigger || true
fi

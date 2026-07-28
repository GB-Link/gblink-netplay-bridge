#!/bin/sh
set -e
rm -f /usr/lib/udev/rules.d/70-gblink.rules
udevadm control --reload-rules || true

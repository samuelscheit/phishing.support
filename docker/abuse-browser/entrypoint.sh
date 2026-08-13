#!/bin/sh
set -eu

profile=/data/profile
extension=/opt/dbc-extension
mkdir -p "$profile"

chrome_args="--remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 --user-data-dir=$profile --no-first-run --no-default-browser-check --disable-component-update --disable-background-networking --disable-sync --disable-dev-shm-usage --disable-gpu --disable-features=OptimizationHints,MediaRouter --disable-extensions-except=$extension --load-extension=$extension about:blank"

start_chrome() {
	# Chrome must run headed behind Xvfb: the DBC extension is explicitly loaded
	# and we do not use --disable-extensions or a personal browser profile.
	xvfb-run -a --server-args="-screen 0 1920x1080x24 -nolisten tcp" google-chrome-stable --no-sandbox $chrome_args &
	chrome_pid=$!
}

stop_chrome() {
	if kill -0 "$chrome_pid" 2>/dev/null; then
		kill -TERM "$chrome_pid" 2>/dev/null || true
		wait "$chrome_pid" 2>/dev/null || true
	fi
}

start_chrome
if [ -r "${DBC_USERNAME_FILE:-/run/secrets/dbc_username}" ] && [ -r "${DBC_PASSWORD_FILE:-/run/secrets/dbc_password}" ]; then
	node /opt/bootstrap-dbc.mjs
	# The extension reads its configuration while its service worker starts. A
	# clean restart makes the persisted private profile authoritative.
	stop_chrome
	start_chrome
else
	printf '%s\n' "DBC credential files are absent; browser is available only for disabled-provider compatibility checks." >&2
fi

trap 'stop_chrome; exit 0' INT TERM
wait "$chrome_pid"

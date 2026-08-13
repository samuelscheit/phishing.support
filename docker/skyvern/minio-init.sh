#!/bin/sh
set -eu

for attempt in $(seq 1 60); do
	if mc alias set skyvern http://skyvern-minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && mc ready skyvern >/dev/null 2>&1; then
		break
	fi
	if [ "$attempt" = 60 ]; then
		echo "MinIO did not become ready in time." >&2
		exit 1
	fi
	sleep 2
done

for bucket in skyvern-artifacts skyvern-screenshots skyvern-browser-sessions skyvern-uploads; do
	mc mb --ignore-existing "skyvern/$bucket"
done

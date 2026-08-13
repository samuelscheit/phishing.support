#!/bin/sh
set -eu

key_directory=/run/skyvern
key_file="$key_directory/api-key"
umask 077
mkdir -p "$key_directory"

# Readiness is harmless and may be retried.  `/repair`, in contrast,
# regenerates the local organization token; retrying a POST whose response was
# lost would create an ambiguous key rotation. Wait for the read-only status
# endpoint first, then call repair exactly once and fail loudly if that one
# request cannot be confirmed.
for attempt in $(seq 1 60); do
	if curl --fail --silent --show-error --max-time 5 http://skyvern:8000/api/v1/internal/auth/status >/dev/null; then
		break
	fi
	if [ "$attempt" = 60 ]; then
		printf '%s\n' "Skyvern API did not become ready for API-key bootstrap." >&2
		exit 1
	fi
	sleep 2
done

# Do not add curl --retry here. This endpoint is intentionally non-idempotent.
response="$(curl --fail --silent --show-error --max-time 20 --request POST http://skyvern:8000/api/v1/internal/auth/repair)"
api_key="$(printf '%s' "$response" | sed -n 's/.*"api_key":"\([A-Za-z0-9._-][A-Za-z0-9._-]*\)".*/\1/p')"

if ! printf '%s' "$api_key" | grep -Eq '^[A-Za-z0-9._-]{20,}$'; then
	printf '%s\n' "Skyvern local-auth repair did not return a valid API key." >&2
	exit 1
fi

temporary_key_file="$key_file.tmp"
printf '%s' "$api_key" > "$temporary_key_file"
chmod 0400 "$temporary_key_file"
mv -f "$temporary_key_file" "$key_file"

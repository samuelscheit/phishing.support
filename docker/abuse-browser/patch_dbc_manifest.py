from __future__ import annotations

import json
from pathlib import Path


EXTENSION_ID = "ejagiilfhmflpcohicichiokfoofeljp"
# This is the signed CRX public key. Supplying it in the unpacked manifest
# preserves Chrome's reviewed extension ID while the update URL is removed.
EXTENSION_PUBLIC_KEY = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnLsWADNuhzdptXSgyFl2"
    "wRCUbEeNzUwP0oe20bceiwBxEA/+Go0ydZzEn/spn1gL4XUu3K34zmrJtZVidLMG"
    "KQaJi3Hq6otq8AddHDakvrXNLWwNtydqP0RF/+7Ex+nMJ0m1BBiYJR8rGh+3sBbW"
    "FJbQ2ifm+NlcRR/rFlaCo5I4JfguApb8d5sZgvIFeEJ6RslSjGDGTA3OUECe/hqT"
    "c3sbDrKpUIv1GB+CeYhcPedJ+6v92pvh/1lwRF28HtIu/nS7VKoWaUMgo0/0QwuQ"
    "eTTpMNVeJgqC7QvRcBuuU+0xYKi6P+aljxzjthp0zAVFK9io5j5n7mwpXJyrrt54"
    "cQIDAQAB"
)


def main() -> None:
    manifest_path = Path("/opt/dbc-extension/manifest.json")
    manifest = json.loads(manifest_path.read_text("utf-8"))
    if manifest.get("manifest_version") != 3 or manifest.get("version") != "2.0.3":
        raise SystemExit("Unexpected DBC extension manifest.")
    manifest.pop("update_url", None)
    manifest["key"] = EXTENSION_PUBLIC_KEY
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":")) + "\n", "utf-8")


if __name__ == "__main__":
    main()

FROM node:24-bookworm-slim

ARG DBC_EXTENSION_URL="https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0.0.0&acceptformat=crx3&x=id%3Dejagiilfhmflpcohicichiokfoofeljp%26uc"
ARG DBC_EXTENSION_SHA256="532c810e8eb559efd49267d33870641bdd77a41742f4f7e2b687599fc8686aeb"

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl gnupg python3 unzip xauth xvfb \
	&& rm -rf /var/lib/apt/lists/* \
	&& curl --fail --silent --show-error https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes --output /usr/share/keyrings/google-chrome.gpg \
	&& echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends google-chrome-stable \
	&& rm -rf /var/lib/apt/lists/*

RUN set -eux; \
	curl --fail --location --silent --show-error "$DBC_EXTENSION_URL" --output /tmp/dbc.crx; \
	echo "$DBC_EXTENSION_SHA256  /tmp/dbc.crx" | sha256sum --check --status; \
	python3 -c 'from pathlib import Path; p=Path("/tmp/dbc.crx").read_bytes(); assert p[:4] == b"Cr24"; n=int.from_bytes(p[8:12], "little"); Path("/tmp/dbc.zip").write_bytes(p[12+n:])'; \
	mkdir -p /opt/dbc-extension; \
	unzip -q /tmp/dbc.zip -d /opt/dbc-extension; \
	rm -f /tmp/dbc.crx /tmp/dbc.zip

COPY docker/abuse-browser/patch_dbc_manifest.py /opt/patch_dbc_manifest.py
RUN python3 /opt/patch_dbc_manifest.py

COPY --chmod=755 docker/abuse-browser/entrypoint.sh /usr/local/bin/abuse-browser
COPY docker/abuse-browser/bootstrap-dbc.mjs /opt/bootstrap-dbc.mjs

RUN useradd --create-home --shell /usr/sbin/nologin abuse-browser \
	&& mkdir -p /data/profile \
	&& chown -R abuse-browser:abuse-browser /data

USER abuse-browser
ENTRYPOINT ["/usr/local/bin/abuse-browser"]

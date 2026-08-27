# rm04-spec Implementation §1. Pin the Kestra base BY DIGEST (code-standards
# §3.10, D2) — exactly as infra/docker/postgres/Dockerfile pins postgres by
# @sha256. udr_rated.rating_engine_version IS this image's tag/digest
# (Inv #12); an unpinned base makes a historical charge irreproducible.
#
# PLACEHOLDER — <KESTRA_VERSION>/<digest> must be filled with the chosen
# stable Kestra OSS release before first build (D0 spike, then D2). This
# session has no network/registry access to resolve the current digest, so
# shipping a fabricated one would be worse than leaving the spec's own
# placeholder in place. See ratemgmt-progress-tracker.md.
FROM kestra/kestra:<KESTRA_VERSION>@sha256:<digest>

USER root
# Python 3.12 (D3 — process-runner tasks run inside this container; ACA has no
# Docker daemon). The exact apt package names are distro-dependent and must be
# confirmed against the base image the D0 spike pins: Debian bookworm ships
# 3.11 as `python3` and has no `python3.12` package, so this line may need
# adjusting (e.g. deadsnakes/a python3.12 base) once the base is chosen.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3.12 python3.12-venv \
 && rm -rf /var/lib/apt/lists/*

# A dedicated venv built FROM python3.12 so pip targets the 3.12 interpreter.
# The base image's system `pip3` (from python3-pip) binds to the base's own
# python (3.11 on bookworm), which would install the cp312-pinned wheels
# against the wrong interpreter; the venv avoids that and isolates the runtime
# libs from the base's Python packages. PATH export makes `python`/`pip`
# resolve to the venv for the kestra process-runner tasks too.
ENV RATING_VENV=/opt/rating-runtime
RUN python3.12 -m venv "$RATING_VENV"
ENV PATH="$RATING_VENV/bin:$PATH"

# --require-hashes WITHOUT --no-deps: every package pip installs — including
# the full transitive graph (cryptography, msal, azure-core, ...) — must be
# present in requirements.txt with a hash, so an incomplete file FAILS the
# build loudly (pip refuses to proceed). This is deliberate: --no-deps would
# instead install only the five top-level pins and silently ship an image
# whose `import azure.identity` breaks at runtime. requirements.txt must be
# pip-compiled with --generate-hashes before this build can succeed (D3).
COPY requirements.txt /tmp/requirements.txt
RUN pip install --require-hashes -r /tmp/requirements.txt

# Rating runtime code (parsers, RL loader, log emitter) is copied in a later
# unit; rm04 bakes only the interpreter + libraries so the image is stable
# across rm07-rm12 (D2 — a Kestra version bump is the only thing that
# rebuilds/revalidates it).
USER kestra

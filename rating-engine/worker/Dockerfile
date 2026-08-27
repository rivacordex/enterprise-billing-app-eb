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
# Python 3.12 + build essentials for psycopg/pyarrow wheels, then the rating
# runtime (D3 — process-runner tasks run inside this container, ACA has no
# Docker daemon).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3.12 python3-pip \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip3 install --require-hashes --no-deps -r /tmp/requirements.txt

# Rating runtime code (parsers, RL loader, log emitter) is copied in a later
# unit; rm04 bakes only the interpreter + libraries so the image is stable
# across rm07-rm12 (D2 — a Kestra version bump is the only thing that
# rebuilds/revalidates it).
USER kestra

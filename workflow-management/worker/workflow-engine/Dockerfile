# wfm01 §2 / wfm-architecture §4.1. THE ONE shared process-runner image
# (`workflow-engine`) — one custom image serves BOTH platform functions (rating
# + bill run) on the collapsed-by-default topology; bill run carries no worker
# of its own, it rides this image. Runs `server standalone` as a PROCESS RUNNER:
# ACA has no Docker daemon, so Kestra's Docker task runner is unavailable and
# every task runs in-process on this image (no Docker-in-Docker, ever).
#
# Kestra OSS base pinned BY DIGEST (code-standards §3.10, D2) — exactly as
# infra/docker/postgres/Dockerfile pins postgres by @sha256. The image
# tag/digest IS the value stamped into udr_rated.rating_engine_version (Inv #12);
# an unpinned base makes a historical charge irreproducible.
#
# v1.3.35 is the current stable head of Kestra's 1.3 line (Docker Hub, resolved
# 2026-08-27; digest verified via `docker buildx imagetools inspect`). The
# plain tag is the WITH-plugins image, which bundles the Azure Blob storage
# plugin that kestra.yml's `storage.type: azure` needs (the -no-plugins variant
# does not). When bumping the version, re-resolve the digest and re-run the D0
# process-runner spike on ACA.
FROM kestra/kestra:v1.3.35@sha256:0b880e20e403ef635a6bc7e9e72786c7a6dde143858723449dc57500830868e2

USER root
# Postgres client (libpq + `psql`) as a system dep so ANY function's task can act
# on the DB directly (wfm01 §2 / D-B). The base is Ubuntu-derived; keep the
# apt cache out of the layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# The Kestra image already ships CPython 3.12 in a uv-managed venv at
# /app/.venv (first on PATH — the interpreter Kestra's Python script/commands
# tasks resolve) plus `uv` at /usr/bin/uv, so there is NO pip bootstrap to do.
# Install the billing-data runtime libraries (D3) straight into that venv with
# uv so every process-runner Python task can import them. --require-hashes
# makes the fully-pinned, uv-compiled requirements.txt a hard reproducibility
# gate: any package (incl. transitive) missing a matching hash fails the build.
COPY requirements.txt /tmp/requirements.txt
RUN uv pip install --python /app/.venv/bin/python --require-hashes -r /tmp/requirements.txt

# rm06-spec Implementation §6 — the rating runtime package (db/storage/
# transform/logemit plumbing plus rm06's log_sweep + emit_terminal_log)
# baked into the image, importable as `runtime` from any Kestra Python task
# (ratemgmt-code-standards.md §3.2's process-runner tasks). PYTHONPATH=/app
# puts the package's PARENT dir on the path so `import runtime` / `python3 -m
# runtime.log_sweep` resolve regardless of the task's own working directory;
# COPY'ing runtime/ directly to /app/runtime (not flattened) keeps its
# internal relative imports (`from . import db, logemit`, runtime/__init__.py)
# intact.
COPY runtime/ /app/runtime/
ENV PYTHONPATH=/app

USER kestra

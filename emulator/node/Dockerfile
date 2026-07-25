# Bridge image (deployment.md D2). The period programs are imported from the
# public real-wopr-programs pack (tools/import-programs.sh) and built in the
# 'programs' stage; the runtime stage is Python + the language runtimes, with
# the built pack copied in. The programs' ONLY distribution channel into the
# running exchange is this image (D7).
#
# Build from the REPO ROOT:  docker build -f api-bridge/Dockerfile .

FROM debian:bookworm-slim AS programs
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates make gfortran sbcl gnucobol bwbasic cc65 gcc \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY packs.lock ./
COPY tools ./tools
# Clone the pinned pack (public — no credentials), build every program, and run
# its golden suite in-image (the programs' conformance check moves here from the
# old per-language stages).
RUN tools/import-programs.sh && ( cd build/pack && tools/test.sh )

FROM python:3.12-slim
WORKDIR /app

COPY api-bridge/pyproject.toml api-bridge/README.md ./
COPY api-bridge/app ./app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgfortran5 gnucobol bwbasic cc65 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir ".[prod]"

# The built program pack: games/systems/joshua sources, manifests, and binaries
# in the pack layout (<cat>/<id>/harness/bin/<binary>). The system wrappers
# (school, protovision) resolve their source relative to the binary, so the
# whole pack tree is copied, not just the binaries.
COPY --from=programs /src/build/pack /opt/wopr/pack

# Smoke: each SYSTEM/1 system must actually run in the runtime image (proves the
# language runtime + wrapper are present) — fails the build if not.
RUN printf 'SYSTEM/1 airline CONNECT\nSTATE 0\nEND\n' \
      | /opt/wopr/pack/systems/airline/harness/bin/airline | grep -q PANAMAC
RUN printf 'SYSTEM/1 school CONNECT\nSTATE 0\nEND\n' \
      | /opt/wopr/pack/systems/school/harness/bin/school | grep -q 'GOOSE LAKE'
RUN printf 'SYSTEM/1 protovision CONNECT\nSTATE 0\nEND\n' \
      | /opt/wopr/pack/systems/protovision/harness/bin/protovision | grep -q PROTOVISION
RUN printf 'SYSTEM/1 pactel CONNECT\nSTATE 0\nEND\n' \
      | /opt/wopr/pack/systems/pactel/harness/bin/pactel | grep -q 'PACIFIC TELEPHONE'

ENV BRIDGE_GAMES_DIR=/opt/wopr/pack/games \
    BRIDGE_SYSTEMS_DIR=/opt/wopr/pack/systems \
    BRIDGE_JOSHUA_LISP_BIN=/opt/wopr/pack/joshua/harness/bin/joshua

EXPOSE 8000
# --loop asyncio: uvloop's libuv socketpair stdio breaks the GnuCOBOL systems'
# stdin (defense in depth alongside the loop-agnostic SystemRunner).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--loop", "asyncio"]

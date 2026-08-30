# Node-host image (deployment.md D2). The 'programs' stage builds every period
# program from source and runs its golden suite in-image; the runtime stage is
# Python + the language runtimes, with the built pack copied in. The programs'
# ONLY distribution channel into the running exchange is this image (D7).
#
# Build from the PACK ROOT:  docker build -f emulator/node/Dockerfile .

# No import step — this repo *is* the pack, so the programs are built in place.
# python3 is here for tools/categories.sh, which reads the category list off
# pack.json; the runtime stage below has its own Python.
FROM debian:bookworm-slim AS programs
RUN apt-get update && apt-get install -y --no-install-recommends \
      make gfortran sbcl gnucobol bwbasic cc65 gcc python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY tools ./tools
COPY pack.json ./
# One COPY per category pack.json declares. Docker cannot ask categories.sh
# which directories those are, so this is the one list-shaped spot left after
# #100/#104 — and tests/test_dockerfile_pack.py holds it to categories.sh, so a
# new category that is not copied in fails the suite, not the build.
COPY games ./games
COPY systems ./systems
COPY joshua ./joshua
COPY wopr ./wopr
COPY norad ./norad
RUN tools/build.sh && tools/test.sh

FROM python:3.12-slim
WORKDIR /app

COPY emulator/node/pyproject.toml emulator/node/README.md ./
COPY emulator/node/app ./app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgfortran5 gnucobol bwbasic cc65 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir ".[prod]"

# The built program pack: every category's sources, manifests, and
# binaries in the pack layout (<cat>/<id>/harness/bin/<binary>). The system
# wrappers (school-mon, school, protovision) resolve their source relative to
# the binary, so the whole pack tree is copied, not just the binaries.
COPY --from=programs /src /opt/wopr/pack

# Smoke: each SYSTEM/1 system must actually run in the runtime image (proves the
# language runtime + wrapper are present) — fails the build if not.
RUN printf 'SYSTEM/1 airline CONNECT\nSTATE 0\nEND\n' \
      | /opt/wopr/pack/systems/airline/harness/bin/airline | grep -q PANAMAC
RUN printf 'SYSTEM/1 school-mon CONNECT\nSTATE 0\nEND\n' \
      | /opt/wopr/pack/systems/school-mon/harness/bin/school-mon | grep -q 'SEATTLE PUBLIC SCHOOL DISTRICT'
RUN printf 'SYSTEM/1 school CONNECT\nSTATE 0\nEND\n' \
      | /opt/wopr/pack/systems/school/harness/bin/school | grep -q 'DISTRICT DATANET'
RUN printf 'SYSTEM/1 protovision CONNECT\nSTATE 0\nEND\n' \
      | /opt/wopr/pack/systems/protovision/harness/bin/protovision | grep -q PROTOVISION
RUN printf 'SYSTEM/1 pactel CONNECT\nSTATE 0\nEND\n' \
      | /opt/wopr/pack/systems/pactel/harness/bin/pactel | grep -q 'PACIFIC TELEPHONE'
# The executive is on every terminal turn, so an image without it is an image
# that cannot route a single line — worth its own smoke test, not just a COPY.
RUN printf 'SYSTEM/1 wopr INPUT\nSTATE 0\nINPUT JOSHUA\nFACTS 1\nSURFACE home-terminal\nEND\n' \
      | /opt/wopr/pack/wopr/harness/bin/wopr | grep -q 'GREETINGS PROFESSOR FALKEN.'

# Every *_DIR the bridge reads must point into the copied pack: config.py falls
# back to the source tree (/app) otherwise, where no binary exists, and the
# bridge drops every line with "no binary for system 'wopr'" (the executive
# went unpinned here from #98 until the probe in real-wopr#228 found it).
# tests/test_dockerfile_env.py holds this ENV block to config.py's key list.
ENV BRIDGE_GAMES_DIR=/opt/wopr/pack/games \
    BRIDGE_SYSTEMS_DIR=/opt/wopr/pack/systems \
    BRIDGE_EXECUTIVE_DIR=/opt/wopr/pack \
    BRIDGE_JOSHUA_LISP_BIN=/opt/wopr/pack/joshua/harness/bin/joshua

EXPOSE 8000
# --factory: `app.main` exposes create_app() and no module-level instance, so
# nothing is built from the environment until the server asks (#84).
# --loop asyncio: uvloop's libuv socketpair stdio breaks the GnuCOBOL systems'
# stdin (defense in depth alongside the loop-agnostic SystemRunner).
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--loop", "asyncio"]

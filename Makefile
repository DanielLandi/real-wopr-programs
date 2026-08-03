# real-wopr-programs — build, test, and package the period-language programs.
.PHONY: build deps test pack clean up map host
build:                 ## build every program (needs the per-language toolchains)
	@tools/build.sh
test: build            ## build then golden-test every program + behavior checks
	@tools/test.sh
	@tools/behavior.sh
pack:                  ## produce dist/real-wopr-programs.woprpack
	@tools/pack.sh
deps:                  ## install what the harness needs to run (node + python)
	@tools/deps.sh
up: build deps         ## bring the whole federation up (relays + nodes)
	@node emulator/cli/src/main.ts up --pack .
map: deps              ## print the topology without starting anything
	@node emulator/cli/src/main.ts map --pack .
host: build deps       ## run this machine as a hosted exchange (ties into the hub)
	@tools/host.sh
clean:                 ## remove build output and packages
	@rm -rf games/*/harness/bin games/*/*/harness/bin systems/*/harness/bin joshua/harness/bin dist

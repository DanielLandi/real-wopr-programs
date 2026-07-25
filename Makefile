# real-wopr-programs — build, test, and package the period-language programs.
.PHONY: build test pack clean up map
build:                 ## build every program (needs the per-language toolchains)
	@tools/build.sh
test: build            ## build then golden-test every program + behavior checks
	@tools/test.sh
	@tools/behavior.sh
pack:                  ## produce dist/real-wopr-programs.woprpack
	@tools/pack.sh
up: build              ## bring the whole federation up (relays + nodes)
	@node emulator/cli/src/main.ts up --pack .
map:                   ## print the topology without starting anything
	@node emulator/cli/src/main.ts map --pack .
clean:                 ## remove build output and packages
	@rm -rf games/*/harness/bin systems/*/harness/bin joshua/harness/bin dist

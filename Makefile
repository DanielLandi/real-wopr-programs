# real-wopr-programs — build, test, and package the period-language programs.
.PHONY: build test pack clean
build:                 ## build every program (needs the per-language toolchains)
	@tools/build.sh
test: build            ## build then golden-test every program
	@tools/test.sh
pack:                  ## produce dist/real-wopr-programs.woprpack
	@tools/pack.sh
clean:                 ## remove build output and packages
	@rm -rf games/*/harness/bin systems/*/harness/bin joshua/harness/bin dist

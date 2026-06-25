# Solidity dependencies live in lib/ but are gitignored and are NOT git submodules, so a fresh clone
# (e.g. an auditor's) has no libs and `forge build` fails. From the repo root run
# `make -C contracts install-contract-deps` (or `make install-contract-deps` from contracts/) to fetch
# the EXACT pinned versions the contracts were written and tested against.
#
# Keep these pins in sync if you ever bump a dependency:
FORGE_STD_REF := 257559546b763ec5fa7371fb77fef9102db86446
OZ_REF        := v5.1.0 # 69c8def5f222ff96f2b5beff05dfba996368aa79

.PHONY: install-contract-deps fmt-check

install-contract-deps:
	rm -rf lib/forge-std lib/openzeppelin-contracts
	git clone https://github.com/foundry-rs/forge-std lib/forge-std
	git -C lib/forge-std checkout $(FORGE_STD_REF)
	git -C lib/forge-std submodule update --init --recursive
	git clone https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
	git -C lib/openzeppelin-contracts checkout $(OZ_REF)

fmt-check:
	forge fmt --check

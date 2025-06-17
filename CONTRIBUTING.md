# Development

## Environment

```bash
# install dependencies
yarn --frozen-lockfile

# compile contracts
yarn compile
```

## Flare-smart-contracts dependency

Currently, [`flare-smart-contracts`](https://gitlab.com/flarenetwork/flare-smart-contracts) dependency is obtained directly from git repository from a tag that supports the required functionality.

For development, it might be beneficial to directly use checked-out code of `flare-smart-contracts`. This can be done with `yarn link`:

1. clone [`flare-smart-contracts`](https://gitlab.com/flarenetwork/flare-smart-contracts)
1. In `flare-smart-contracts` project folder run `yarn link`
1. In `fasset` (this) project folder run `yarn link flare-smart-contracts`

This creates softlink from `node_modules/flare-smart-contracts` to the flare-smart-contracts project folder.

For development in _VSCode_ you might also find VSCode _Workspace_ feature useful - it allows you to have multiple projects open in the same window (e.g. both fasset and flare-smart-contracts).

## Tests

<!-- add paragraph about hardhat and foundry tests after they are setup -->

### How to run

```bash
# recompile contracts before running tests
yarn compile

# all hardhat tests
yarn test

# unit and integration tests in hardhat environmet
yarn testHH`

# only unit tests in hardhat environment.
yarn test_unit_hh

# only integration tests in hardhat environment.
yarn test_integration_hh

# generate coverage report
yarn cov
```

## Static analysis

There are currently three linters included in this repository:

- `eslint` javascript linter
- `solhint` solidity linter
- `slither` solidity static analyser

### Install slither

[Slither](https://github.com/crytic/slither) is an external tool that isn't managed by project's dependencies. As such it needs to be installed manually. We provide a script that depends on installed `pip3`.

```bash
# installs slither via pip if slither executable isn't found in PATH
yarn install-slither
```

If you wish to install slither yourself you can check their instructions [here](https://github.com/crytic/slither?tab=readme-ov-file#how-to-install).

### How to run

```bash
# run eslint
yarn eslint

# run solhint
yarn lint

# run slither
yarn slither
```

<!---->
<!-- ## Docker -->
<!---->
<!-- Basic [`Dockerfile`](./Dockerfile) is provided. It installs dependencies and compiles the contracts. All the tooling can be run through docker.  -->
<!---->
<!-- ```bash -->
<!-- # build the image and tag it with local/fasset -->
<!-- docker build -t local/fasset . -->
<!---->
<!-- # run tests -->
<!-- docker run --rm local/fasset yarn test -->
<!-- ``` -->

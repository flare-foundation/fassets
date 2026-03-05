# Development

## Environment

```bash
# install dependencies
yarn --frozen-lockfile

# compile contracts
yarn compile
```

## Tests

<!-- add paragraph about hardhat and foundry tests after they are setup -->

### How to run

```bash
# recompile contracts before running tests
yarn compile

# all hardhat tests
yarn test

# unit and integration tests in hardhat environment
yarn testHH`

# only unit tests in hardhat environment
yarn test_unit_hh

# only integration tests in hardhat environment
yarn test_integration_hh

# run e2e tests
yarn test_e2e

# generate coverage report
yarn test-with-coverage
```

## Using Foundry

1. Install Foundryup:
    ```bash
    curl -L https://foundry.paradigm.xyz | bash
    foundryup
    ```
2. Run `git submodule update --init --recursive` to initialize the `forge-std` submodule.
3. Compile the solidity code for forge: `forge build`.

To run all tests of a contract use

```bash
forge test --mc <contract_name>
```

To run a specific test function use

```bash
forge test --mt <test_name>
```

The default behavior for forge test is to only display a summary of passing and failing tests. To show more information change the verbosity level with the `-v` flag:

-   `-vv>`: displays logs emitted during tests, including assertion errors (e.g., expected vs. actual values).
-   `-vvv`: shows execution traces for failing tests, in addition to logs.
-   `-vvvv`: displays execution traces for all tests and setup traces for failing tests.
-   `-vvvvv`: provides the most detailed output, showing execution and setup traces for all tests, including storage changes.

## Static analysis

There are currently three linters included in this repository:

-   `eslint` javascript linter
-   `solhint` solidity linter
-   `slither` solidity static analyser

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

## Review scope and audits

When reviewing the code, either as part of a bug bounty program, audit competition, or regular code review, please consider the following scope.

### In scope

All non-mock Solidity contracts under the `contracts/` directory:

```
contracts/agentOwnerRegistry/**/*
contracts/agentVault/**/*
contracts/assetManager/**/*
contracts/assetManagerController/**/*
contracts/collateralPool/**/*
contracts/coreVaultManager/**/*
contracts/diamond/**/*
contracts/fassetToken/**/*
contracts/fdc/**/*
contracts/flareSmartContracts/**/*
contracts/ftso/**/*
contracts/governance/**/*
contracts/openzeppelin/**/*
contracts/userInterfaces/**/*
contracts/utils/**/*
contracts/mintingTagManager/**/*
```

### Explicit scope

Complete list of **160** in-scope Solidity files:

```
contracts/agentOwnerRegistry/implementation/AgentOwnerRegistry.sol
contracts/agentOwnerRegistry/implementation/AgentOwnerRegistryProxy.sol
contracts/agentVault/implementation/AgentVault.sol
contracts/agentVault/implementation/AgentVaultFactory.sol
contracts/agentVault/interfaces/IIAgentVault.sol
contracts/agentVault/interfaces/IIAgentVaultFactory.sol
contracts/assetManager/diamondInitializers/AssetManagerInit.sol
contracts/assetManager/diamondInitializers/DirectMintingAndRedeemExtendedInit.sol
contracts/assetManager/facets/AgentAlwaysAllowedMintersFacet.sol
contracts/assetManager/facets/AgentCollateralFacet.sol
contracts/assetManager/facets/AgentInfoFacet.sol
contracts/assetManager/facets/AgentPingFacet.sol
contracts/assetManager/facets/AgentSettingsFacet.sol
contracts/assetManager/facets/AgentVaultAndPoolSupportFacet.sol
contracts/assetManager/facets/AgentVaultManagementFacet.sol
contracts/assetManager/facets/AssetManagerBase.sol
contracts/assetManager/facets/AssetManagerDiamondCutFacet.sol
contracts/assetManager/facets/AvailableAgentsFacet.sol
contracts/assetManager/facets/ChallengesFacet.sol
contracts/assetManager/facets/CollateralReservationsFacet.sol
contracts/assetManager/facets/CollateralTypesFacet.sol
contracts/assetManager/facets/CoreVaultClientFacet.sol
contracts/assetManager/facets/CoreVaultClientSettingsFacet.sol
contracts/assetManager/facets/DirectMintingFacet.sol
contracts/assetManager/facets/DirectMintingSettingsFacet.sol
contracts/assetManager/facets/EmergencyPauseFacet.sol
contracts/assetManager/facets/LiquidationFacet.sol
contracts/assetManager/facets/MintingDefaultsFacet.sol
contracts/assetManager/facets/MintingFacet.sol
contracts/assetManager/facets/RedemptionConfirmationsFacet.sol
contracts/assetManager/facets/RedemptionDefaultsFacet.sol
contracts/assetManager/facets/RedemptionRequestsFacet.sol
contracts/assetManager/facets/RedemptionTimeExtensionFacet.sol
contracts/assetManager/facets/SettingsManagementFacet.sol
contracts/assetManager/facets/SettingsReaderFacet.sol
contracts/assetManager/facets/SystemInfoFacet.sol
contracts/assetManager/facets/SystemStateManagementFacet.sol
contracts/assetManager/facets/UnderlyingBalanceFacet.sol
contracts/assetManager/facets/UnderlyingTimekeepingFacet.sol
contracts/assetManager/implementation/AssetManager.sol
contracts/assetManager/interfaces/IIAssetManager.sol
contracts/assetManager/interfaces/IISettingsManagement.sol
contracts/assetManager/library/AgentBacking.sol
contracts/assetManager/library/AgentCollateral.sol
contracts/assetManager/library/AgentPayout.sol
contracts/assetManager/library/Agents.sol
contracts/assetManager/library/AgentUpdates.sol
contracts/assetManager/library/CollateralTypes.sol
contracts/assetManager/library/Conversion.sol
contracts/assetManager/library/CoreVaultClient.sol
contracts/assetManager/library/data/Agent.sol
contracts/assetManager/library/data/AssetManagerState.sol
contracts/assetManager/library/data/Collateral.sol
contracts/assetManager/library/data/CollateralReservation.sol
contracts/assetManager/library/data/CollateralTypeInt.sol
contracts/assetManager/library/data/MintingRateLimiter.sol
contracts/assetManager/library/data/PaymentConfirmations.sol
contracts/assetManager/library/data/PaymentReference.sol
contracts/assetManager/library/data/Redemption.sol
contracts/assetManager/library/data/RedemptionQueue.sol
contracts/assetManager/library/data/RedemptionTimeExtension.sol
contracts/assetManager/library/data/UnderlyingAddressOwnership.sol
contracts/assetManager/library/DirectMinting.sol
contracts/assetManager/library/EffectiveEmergencyPause.sol
contracts/assetManager/library/Globals.sol
contracts/assetManager/library/Liquidation.sol
contracts/assetManager/library/LiquidationPaymentStrategy.sol
contracts/assetManager/library/Minting.sol
contracts/assetManager/library/RedemptionDefaults.sol
contracts/assetManager/library/RedemptionQueueInfo.sol
contracts/assetManager/library/RedemptionRequests.sol
contracts/assetManager/library/Redemptions.sol
contracts/assetManager/library/SettingsInitializer.sol
contracts/assetManager/library/SettingsUpdater.sol
contracts/assetManager/library/SettingsValidators.sol
contracts/assetManager/library/TransactionAttestation.sol
contracts/assetManager/library/UnderlyingBalance.sol
contracts/assetManager/library/UnderlyingBlockUpdater.sol
contracts/assetManagerController/implementation/AssetManagerController.sol
contracts/assetManagerController/implementation/AssetManagerControllerProxy.sol
contracts/assetManagerController/interfaces/IIAssetManagerController.sol
contracts/collateralPool/implementation/CollateralPool.sol
contracts/collateralPool/implementation/CollateralPoolFactory.sol
contracts/collateralPool/implementation/CollateralPoolToken.sol
contracts/collateralPool/implementation/CollateralPoolTokenFactory.sol
contracts/collateralPool/interfaces/IICollateralPool.sol
contracts/collateralPool/interfaces/IICollateralPoolFactory.sol
contracts/collateralPool/interfaces/IICollateralPoolToken.sol
contracts/collateralPool/interfaces/IICollateralPoolTokenFactory.sol
contracts/coreVaultManager/implementation/CoreVaultManager.sol
contracts/coreVaultManager/implementation/CoreVaultManagerProxy.sol
contracts/coreVaultManager/interfaces/IICoreVaultManager.sol
contracts/diamond/facets/DiamondLoupeFacet.sol
contracts/diamond/implementation/Diamond.sol
contracts/diamond/interfaces/IDiamond.sol
contracts/diamond/interfaces/IDiamondCut.sol
contracts/diamond/interfaces/IDiamondLoupe.sol
contracts/diamond/library/LibDiamond.sol
contracts/fassetToken/implementation/CheckPointable.sol
contracts/fassetToken/implementation/FAsset.sol
contracts/fassetToken/implementation/FAssetProxy.sol
contracts/fassetToken/interfaces/IICheckPointable.sol
contracts/fassetToken/interfaces/IIFAsset.sol
contracts/fassetToken/library/CheckPointHistory.sol
contracts/fassetToken/library/CheckPointsByAddress.sol
contracts/fdc/mockInterface/IFdcVerification.sol
contracts/fdc/mockInterface/IXRPPayment.sol
contracts/fdc/mockInterface/IXRPPaymentVerification.sol
contracts/flareSmartContracts/implementation/AddressUpdatable.sol
contracts/flareSmartContracts/interfaces/IAddressUpdatable.sol
contracts/flareSmartContracts/interfaces/IWNat.sol
contracts/ftso/implementation/FtsoV2PriceStore.sol
contracts/ftso/implementation/FtsoV2PriceStoreProxy.sol
contracts/ftso/interfaces/IPriceChangeEmitter.sol
contracts/ftso/interfaces/IPricePublisher.sol
contracts/ftso/interfaces/IPriceReader.sol
contracts/governance/implementation/Governed.sol
contracts/governance/implementation/GovernedBase.sol
contracts/governance/implementation/GovernedProxyImplementation.sol
contracts/governance/implementation/GovernedUUPSProxyImplementation.sol
contracts/governance/interfaces/IGoverned.sol
contracts/mintingTagManager/MintingTagManager.sol
contracts/mintingTagManager/MintingTagManagerProxy.sol
contracts/openzeppelin/library/Reentrancy.sol
contracts/openzeppelin/security/ReentrancyGuard.sol
contracts/userInterfaces/data/AgentInfo.sol
contracts/userInterfaces/data/AgentSettings.sol
contracts/userInterfaces/data/AssetManagerSettings.sol
contracts/userInterfaces/data/AvailableAgentInfo.sol
contracts/userInterfaces/data/CollateralReservationInfo.sol
contracts/userInterfaces/data/CollateralType.sol
contracts/userInterfaces/data/EmergencyPause.sol
contracts/userInterfaces/data/RedemptionRequestInfo.sol
contracts/userInterfaces/data/RedemptionTicketInfo.sol
contracts/userInterfaces/IAgentAlwaysAllowedMinters.sol
contracts/userInterfaces/IAgentOwnerRegistry.sol
contracts/userInterfaces/IAgentPing.sol
contracts/userInterfaces/IAgentVault.sol
contracts/userInterfaces/IAssetManager.sol
contracts/userInterfaces/IAssetManagerController.sol
contracts/userInterfaces/IAssetManagerEvents.sol
contracts/userInterfaces/ICollateralPool.sol
contracts/userInterfaces/ICollateralPoolToken.sol
contracts/userInterfaces/ICoreVaultClient.sol
contracts/userInterfaces/ICoreVaultClientSettings.sol
contracts/userInterfaces/ICoreVaultManager.sol
contracts/userInterfaces/IDirectMinting.sol
contracts/userInterfaces/IDirectMintingSettings.sol
contracts/userInterfaces/IFAsset.sol
contracts/userInterfaces/IMintingTagManager.sol
contracts/userInterfaces/IRedemptionTimeExtension.sol
contracts/userInterfaces/IRedeemExtended.sol
contracts/utils/interfaces/IUpgradableContractFactory.sol
contracts/utils/interfaces/IUpgradableProxy.sol
contracts/utils/interfaces/IUUPSUpgradeable.sol
contracts/utils/library/MathUtils.sol
contracts/utils/library/MerkleTree.sol
contracts/utils/library/SafeMath64.sol
contracts/utils/library/SafePct.sol
contracts/utils/library/Transfers.sol
```

### Out of scope

Mock contracts (used only in tests) are **excluded**:

```
contracts/**/mock/**/*
contracts/openzeppelin/token/*
contracts/openzeppelin/utils/*
contracts/utils/Imports_Solidity_0_6.sol
```

### Deployment parameters

To review the parameters used in deployments refer to the deployment folder:

```
deployment/deploys/**/*
```

Previous audit reports can be found in the [audit](./audit) folder.

#!/bin/bash

set -e

scripts/makedoc.sh contracts/userInterfaces/IAssetManager.sol
scripts/makedoc.sh contracts/userInterfaces/ICollateralPool.sol
scripts/makedoc.sh contracts/userInterfaces/ICollateralPoolToken.sol
scripts/makedoc.sh contracts/userInterfaces/IMintingTagManager.sol
scripts/makedoc.sh contracts/userInterfaces/IFAsset.sol
scripts/makedoc.sh contracts/userInterfaces/IAgentVault.sol
# scripts/makedoc.sh contracts/userInterfaces/ICoreVaultManager.sol

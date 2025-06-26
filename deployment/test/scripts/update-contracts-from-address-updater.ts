import { runDeployScript } from "../../lib/deploy-scripts";
import { ZERO_ADDRESS } from "../../lib/deploy-utils";

runDeployScript(async ({ hre, artifacts, contracts }) => {
    const AddressUpdater = artifacts.require("IIAddressUpdater");

    // get the freshest address updater
    let addressUpdater = await AddressUpdater.at(contracts.AddressUpdater.address);
    while (true) {
        const newAddressUpdater = await addressUpdater.getContractAddress("AddressUpdater");
        if (newAddressUpdater === addressUpdater.address) break;
        contracts.AddressUpdater.address = newAddressUpdater;
        addressUpdater = await AddressUpdater.at(newAddressUpdater);
        console.log(`Updated AddressUpdater to ${newAddressUpdater}`);
    }

    for (const contract of contracts.list()) {
        const newAddress = await addressUpdater.getContractAddress(contract.name)
            .catch(e => ZERO_ADDRESS);
        if (newAddress === ZERO_ADDRESS) {
            console.log(`Contract ${contract.name} is not in address updater`);
        } else if (contract.address !== newAddress) {
            contract.address = newAddress;
            console.log(`Updated ${contract.name} to ${newAddress}`);
        } else {
            console.log(`${contract.name} not updated.`);
        }
    }

    contracts.save();
});
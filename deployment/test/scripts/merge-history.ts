import { Contract, ContractHistory, ContractStore } from "../../lib/contracts";

// const historyFile = "deployment/deploys/history/coston.json";
// const contractFiles = [
//     "deployment/deploys/coston-qa.json",
//     "deployment/deploys/coston.json",
// ];

const historyFile = "deployment/deploys/history/coston2.json";
const contractFiles = [
    "deployment/deploys/coston2-staging.json",
    "deployment/deploys/coston2-qa.json",
    "deployment/deploys/coston2.json",
];

const history = ContractStore.loadListAsMap<ContractHistory>(historyFile);
const deploys = contractFiles.map(cf => ContractStore.loadListAsMap<Contract>(cf));

for (const item of history.values()) {
    for (const deploy of deploys) {
        const contract = deploy.get(item.name);
        if (contract) {
            const ind = item.addresses.indexOf(contract.address);
            if (ind >= 0) item.addresses.splice(ind, 1);
            item.addresses.push(contract.address);
        }
    }
}

ContractStore.saveMapAsList(historyFile, history);

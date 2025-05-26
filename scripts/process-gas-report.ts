
function padLeft(val: number | string, n=8) {
    return (' '.repeat(n) + val).slice(-n);
} 


function processGasReport() {
    let report = require("../gasReporterOutput.json")
    let methods: any[] = [];
    for (const key of Object.keys(report.info.methods)) {
        methods.push(report.info.methods[key])
    }
    methods = methods.filter((x: any) => x.gasData.length > 0);
    
    methods.sort((a: any, b: any) => {
        if(a.contract < b.contract) return -1;
        if(a.contract > b.contract) return 1;
        if(a.method < b.method) return -1;
        if(a.method > b.method) return 1;
        return 0;
    })

    let result = "## METHODS\n";
    result += `${padLeft("Avg gas")} ${padLeft("Min gas")} ${padLeft("Max gas")} ${padLeft("Count", 5)}   API (Contract)\n`;
    for(let m of methods) {
        let sm = 0;
        for(let el of m.gasData) {
            sm += el;
        }
        result += `${padLeft(Math.round(sm/m.gasData.length))} ${padLeft(Math.min(...m.gasData))} ${padLeft(Math.max(...m.gasData))} ${padLeft(m.numberOfCalls, 5)}   ${m.method} (${m.contract})\n`;
    }

    
    let deployments: any[] = report.info.deployments;
    deployments = deployments.filter((x: any) => x.gasData.length > 0);
    deployments.sort((a: any, b: any) => {
        if(a.name < b.name) return -1;
        if(a.name > b.name) return 1;
        return 0;
    })

    result += "\n## DEPLOYMENTS\n";
    result += `${padLeft("Avg gas")} ${padLeft("Min gas")} ${padLeft("Max gas")} ${padLeft("Count", 5)}   API (Contract)\n`;
    for(let m of deployments) {
        let sm = 0;
        for(let el of m.gasData) {
            sm += el;
        }
        result += `${padLeft(Math.round(sm/m.gasData.length))} ${padLeft(Math.min(...m.gasData))} ${padLeft(Math.max(...m.gasData))} ${padLeft(m.gasData.length, 5)}   ${m.name}\n`;
    }
    const fs = require('fs');

    fs.writeFileSync("gas-costs.txt",result);
}

processGasReport();

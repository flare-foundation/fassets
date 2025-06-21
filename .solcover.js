module.exports = {
    skipFiles: [
        'agentVault/mock',
        'assetManager/library/mock',
        'assetManager/mock',
        'diamond/mock',
        'fassetToken/mock',
        'fdc/mock',
        'flareSmartContracts/mock',
        'ftso/mock',
        'governance/mock',
        'openzeppelin/mock',
        'utils/mock'
    ],
    istanbulReporter: ['html', 'json', 'text-summary', 'lcov']
};

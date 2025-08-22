
/**
 * @description Calc gas cost of a eth transaction.
 * @param {*} result Eth transaction result
 */
export function calcGasCost(response: Truffle.TransactionResponse<Truffle.AnyEvent>) {
    const receipt = response.receipt as TransactionReceipt & { effectiveGasPrice: string };
    // Compute the gas cost of the depositResult
    return web3.utils.toBN(receipt.gasUsed).mul(web3.utils.toBN(receipt.effectiveGasPrice));
};

export function sumGas(tx: Truffle.TransactionResponse<Truffle.AnyEvent>, sum: { gas: number }) {
    sum.gas += (tx.receipt as TransactionReceipt).gasUsed;
}

/**
 * Calculate how much NAT was received by an address in the transaction. (Assumes there is only one transaction per block, so it's only useful for tests.)
 * @param response truffle transaction response
 * @param address optional address; default is the `from` address of the transaction
 */
export async function calculateReceivedNat<T extends Truffle.AnyEvent>(response: Truffle.TransactionResponse<T>, address?: string) {
    const receipt = response.receipt as TransactionReceipt;
    address ??= receipt.from;
    const blockNumber = Number(receipt.blockNumber);
    const balanceBefore = await getBalance(address, blockNumber - 1);
    const balanceAfter = await getBalance(address, blockNumber);
    let receivedNat = balanceAfter.sub(balanceBefore);
    if (address.toLowerCase() === String(receipt.from).toLowerCase()) {
        receivedNat = receivedNat.add(calcGasCost(response))
    }
    return receivedNat;
}

/**
 * Get balance of an address.
 * @param address the address
 * @param blockNumber block number or `"latest"`; default is `web3.eth.defaultBlock`, which is `"latest"` by default
 */
export async function getBalance(address: string, blockNumber?: string | number | BN) {
    return web3.utils.toBN(await web3.eth.getBalance(address, blockNumber ?? web3.eth.defaultBlock));
}

import {SeiUser, UserFactory} from "../User";
import testConfig from "../../config/testConfig.json";
import {Funder} from "../Funder";

export async function waitFor(seconds: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, seconds * 1000);
    });
}

export async function createSeiUsers(admin: SeiUser, numberOfUsers: number) {
    const users = [];
    for (let i = 0; i < numberOfUsers; i++) {
        users.push(new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint));
    }
    await Promise.all(users.map(user => user.initialize('', '', false)));
    const funder = new Funder(admin);
    await funder.fundAddressesOnSei(users);
    await associateAllUsers(users);
    return users;
}

export async function fundAllUsers(funder: Funder, users: SeiUser[]){
    await funder.fundAddressesOnSei(users);
}

export async function associateAllUsers(users: SeiUser[]){
    while(users.length > 0){
        const userSlice = users.slice(0, 150);
        await Promise.all(userSlice.map(user => user.seiWallet.associate()));
        users = users.slice(150);
    }
}

export async function createCtUsers(admin: SeiUser){
    const alice = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
    await alice.initialize('', 'alice', true);
    const bob = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
    await bob.initialize('', 'bob', true);

    await UserFactory.fundAddressOnSei(bob.seiAddress);
    await UserFactory.fundAddressOnSei(alice.seiAddress);

    await alice.seiWallet.associate();
    await bob.seiWallet.associate();
    return {alice, bob};
}

export function hex2uint8(hex: string) {
    const hex_chars = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'];
    hex = hex.toUpperCase();
    let uint8 = new Uint8Array(Math.floor(hex.length/2));
    for (let i=0; i < Math.floor(hex.length/2); i++) {
        uint8[i] = hex_chars.indexOf(hex[i*2])*16;
        uint8[i] += hex_chars.indexOf(hex[i*2+1]);
    }
    return uint8;
}

export interface Eip1559Params {
    blockGasLimit: number;
    targetGasUsedPerBlock: number;
    maxUpwardAdjustment: number;
    maxDownwardAdjustment: number;
    minFeePerGas: number;
    maxFeePerGas: number;
}

const DEFAULT_EIP1559_PARAMS: Eip1559Params = {
    blockGasLimit: 5000000000,
    targetGasUsedPerBlock: 250000,
    maxUpwardAdjustment: 0.0189,
    maxDownwardAdjustment: 0.0039,
    minFeePerGas: 1000000000,
    maxFeePerGas: 1000000000000,
};

export function calcNewBaseFee(
    prevBaseFee: number,
    blockGasUsed: number,
    params: Eip1559Params = DEFAULT_EIP1559_PARAMS
): number {
    const { blockGasLimit, targetGasUsedPerBlock, maxUpwardAdjustment, maxDownwardAdjustment, minFeePerGas, maxFeePerGas } = params;

    let newBaseFee: number;
    if (blockGasUsed > targetGasUsedPerBlock) {
        const numerator = blockGasUsed - targetGasUsedPerBlock;
        const denominator = blockGasLimit - targetGasUsedPerBlock;
        const percentageFull = numerator / denominator;
        const adjustmentFactor = maxUpwardAdjustment * percentageFull;
        newBaseFee = prevBaseFee * (1 + adjustmentFactor);
    } else {
        const numerator = targetGasUsedPerBlock - blockGasUsed;
        const denominator = targetGasUsedPerBlock;
        const percentageEmpty = numerator / denominator;
        const adjustmentFactor = maxDownwardAdjustment * percentageEmpty;
        newBaseFee = prevBaseFee * (1 - adjustmentFactor);
    }

    newBaseFee = Math.floor(newBaseFee);
    if (newBaseFee < minFeePerGas) return minFeePerGas;
    if (newBaseFee > maxFeePerGas) return maxFeePerGas;
    return newBaseFee;
}

export async function queryEip1559Params(): Promise<Eip1559Params> {
    const { exec: execCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const exec = promisify(execCb);

    async function queryParam(key: string): Promise<string> {
        const { stdout } = await exec(`seid query params subspace evm ${key} --output json`);
        const parsed = JSON.parse(stdout);
        return parsed.value.replace(/"/g, '');
    }

    async function queryBlockGasLimit(): Promise<number> {
        const { stdout } = await exec(`seid query params blockparams --output json`);
        const parsed = JSON.parse(stdout);
        return Number(parsed.max_gas);
    }

    const [minFee, maxFee, upward, downward, target, blockGasLimit] = await Promise.all([
        queryParam('KeyMinFeePerGas'),
        queryParam('KeyMaximumFeePerGas'),
        queryParam('KeyMaxDynamicBaseFeeUpwardAdjustment'),
        queryParam('KeyMaxDynamicBaseFeeDownwardAdjustment'),
        queryParam('KeyTargetGasUsedPerBlock'),
        queryBlockGasLimit(),
    ]);

    return {
        blockGasLimit,
        targetGasUsedPerBlock: Number(target),
        maxUpwardAdjustment: parseFloat(upward),
        maxDownwardAdjustment: parseFloat(downward),
        minFeePerGas: parseFloat(minFee),
        maxFeePerGas: parseFloat(maxFee),
    };
}

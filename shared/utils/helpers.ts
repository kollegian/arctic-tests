import {SeiUser, UserFactory} from "../User";
import {getTestConfig} from "../testConfig";
import {Funder} from "../Funder";
import {getChainParams} from "../chainParams";

export async function waitFor(seconds: number): Promise<void> {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, seconds * 1000);
    });
}

export async function createSeiUsers(admin: SeiUser, numberOfUsers: number) {
    const cfg = getTestConfig();
    const users = [];
    for (let i = 0; i < numberOfUsers; i++) {
        users.push(new SeiUser(cfg.seiRpcEndpoint, cfg.evmRpcEndpoint, cfg.restEndpoint));
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

export function calcNewBaseFee(
    prevBaseFee: number,
    blockGasUsed: number
): number {
    const {
        blockGasLimit,
        targetGasUsed,
        maxUpwardAdjustment,
        maxDownwardAdjustment,
        minFeePerGas,
    } = getChainParams();

    if (blockGasUsed > targetGasUsed) {
        const numerator = blockGasUsed - targetGasUsed;
        const denominator = blockGasLimit - targetGasUsed;
        const percentageFull = numerator / denominator;
        const adjustmentFactor = maxUpwardAdjustment * percentageFull;
        const newBaseFee = prevBaseFee * (1 + adjustmentFactor);
        return Math.floor(newBaseFee);
    } else {
        const numerator = targetGasUsed - blockGasUsed;
        const denominator = targetGasUsed;
        const percentageEmpty = numerator / denominator;
        const adjustmentFactor = maxDownwardAdjustment * percentageEmpty;
        const newBaseFee = prevBaseFee * (1 - adjustmentFactor);
        return Math.floor(newBaseFee) < minFeePerGas ? minFeePerGas : Math.floor(newBaseFee);
    }
}

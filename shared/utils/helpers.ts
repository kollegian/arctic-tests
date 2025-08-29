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

export function calcNewBaseFee(
    prevBaseFee: number,
    blockGasUsed: number
): number {
    const blockGasLimit = 10_000_000;
    const targetGasUsed = 850000;
    const maxUpwardAdjustment = 0.007500000000000000; // 1.89%
    const maxDownwardAdjustment = 0.003900000000000000; // 0.39%

    if (blockGasUsed > targetGasUsed) {
        // Upward adjustment
        const numerator = blockGasUsed - targetGasUsed;
        const denominator = blockGasLimit - targetGasUsed;
        const percentageFull = numerator / denominator;
        const adjustmentFactor = maxUpwardAdjustment * percentageFull;
        const newBaseFee = prevBaseFee * (1 + adjustmentFactor);
        return Math.floor(newBaseFee);
    } else {
        // Downward adjustment
        const numerator = targetGasUsed - blockGasUsed;
        const denominator = targetGasUsed;
        const percentageEmpty = numerator / denominator;
        const adjustmentFactor = maxDownwardAdjustment * percentageEmpty;
        const newBaseFee = prevBaseFee * (1 - adjustmentFactor);
        return Math.floor(newBaseFee) < 1000000000 ?  1000000000: Math.floor(newBaseFee);
    }
}

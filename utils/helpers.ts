import {SeiUser, UserFactory} from "../shared/User";
import testConfig from "../config/testConfig.json";
import {Funder} from "../shared/Funder";

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



import {SeiUser} from "../shared/User";
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



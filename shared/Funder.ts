import util from 'node:util';
import {SeiUser} from './User';
import fs from 'fs/promises';
import {coins, StdFee} from "@cosmjs/stargate";
import {waitFor} from "../utils/helpers";

const exec = util.promisify(require('node:child_process').exec);

export class Funder {
    admin;

    constructor(funder: SeiUser) {
        this.admin = funder;
    }

    async fundAdminOnSei(tokenName = 'usei') {
        if (await this.isDocker()) {
            let {stdout} = await exec(`docker exec sei-node-0 /bin/bash -c 'export PATH=$PATH:/root/go/bin:/root/.foundry/bin && printf "12345678\\n" | seid keys show admin -a'`);
            let dockerAdmin = stdout.trimEnd();
            ({stdout} = await exec(`docker exec sei-node-0 /bin/bash -c 'export PATH=$PATH:/root/go/bin:/root/.foundry/bin && printf "12345678\\n" | seid tx bank send ${dockerAdmin} ${this.admin.seiAddress} 1000000000000${tokenName} --fees 24500usei -y'`));
            await waitFor(1);
        } else {
            const {stdout} = await exec(`seid keys show admin -a`);
            await exec(`seid tx bank send ${stdout.trim()} ${this.admin.seiAddress} 100000000000000${tokenName} --fees 24500usei -y`);
            await waitFor(1);
        }
        console.log('Admin wallet funded');
    }

    async fundAddressOnSei(address: string, tokenName = 'usei', amount = '75000000') {
        let {stdout} = await exec(`seid keys show admin -a`);
        const output = await exec(`seid tx bank send ${stdout.trim()} ${address} ${amount}${tokenName} --fees 24500usei -y --broadcast-mode block`);
        await waitFor(1);
        console.log('Address funded');
    }


    async fundAddressesOnSei(users: SeiUser[], amount = '100000000'){
        const remaining = [...users];
        while (remaining.length > 0) {
            const batch = remaining.splice(0, 200);
            const totalAmount = (BigInt(amount) * BigInt(batch.length)).toString();
            const msgMultiSend = {
                typeUrl: "/cosmos.bank.v1beta1.MsgMultiSend",
                value: {
                    inputs: [
                        {
                            address: this.admin.seiAddress,
                            coins: [
                                {
                                    denom: 'usei',
                                    amount: totalAmount,
                                },
                            ],
                        },
                    ],
                    outputs: batch.map((user) => ({
                        address: user.seiAddress,
                        coins: [
                            {
                                denom: 'usei',
                                amount: amount,
                            },
                        ],
                    })),
                },
            };

            const fee: StdFee = {
                amount: coins(1600000, 'usei'),
                gas: "3500000",
            };
            await this.admin.seiWallet.signingClient.signAndBroadcast(this.admin.seiAddress, [msgMultiSend],  fee);
        }
    }


    async isDocker() {
        return new Promise(async (resolve, reject) => {
            const {stdout} = await exec('docker ps --filter \'name=sei-node-0\' --format \'{{.Names}}\'');
            if (stdout.includes('sei-node-0')) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    }

}

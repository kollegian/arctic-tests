import util from 'node:util';
import {waitFor} from '../tokenfactory/helpers';
import {SeiUser} from './User';
import fs from 'fs/promises';
import {coins, StdFee} from "@cosmjs/stargate";

const exec = util.promisify(require('node:child_process').exec);

export class Funder {
  adminAddress = "";

  constructor(address: string) {
    this.adminAddress = address;
  }

  async fundAdminOnSei(tokenName = 'usei') {
    if (await this.isDocker()) {
      let {stdout} = await exec(`docker exec sei-node-0 /bin/bash -c 'export PATH=$PATH:/root/go/bin:/root/.foundry/bin && printf "12345678\\n" | seid keys show admin -a'`);
      let dockerAdmin = stdout.trimEnd();
      ({stdout} = await exec(`seid keys show admin -a`));
      let seiAdmin = stdout.trimEnd();
      ({stdout} = await exec(`docker exec sei-node-0 /bin/bash -c 'export PATH=$PATH:/root/go/bin:/root/.foundry/bin && printf "12345678\\n" | seid tx bank send ${dockerAdmin} ${seiAdmin} 1000000000000usei --fees 24500usei -y'`));
      await waitFor(1);
    } else {
      const {stdout} = await exec(`seid keys show admin -a`);
      await exec(`seid tx bank send ${stdout.trim()} ${this.adminAddress} 100000000000000${tokenName} --fees 24500usei -y`);
      await waitFor(1);
    }
    console.log('Admin wallet funded');
  }

  async fundAddressOnSei(address: string, tokenName = 'usei', amount = '15000000') {
    let {stdout} = await exec(`seid keys show admin -a`);
    ({stdout} = await exec(`seid tx bank send ${stdout.trim()} ${address} ${amount}${tokenName} --fees 24500usei -y --broadcast-mode block`));
    await waitFor(1);
  }

  async fundMultipleAddressesOnsei_2(funder: SeiUser, users: SeiUser[], amount = '1000000'){
    let indexStart = 0;
    let window = users.length / 10;
    while (indexStart < users.length) {
      const totalAmount = (BigInt(amount) * BigInt(10)).toString();
      const msgMultiSend = {
        typeUrl: "/cosmos.bank.v1beta1.MsgMultiSend",
        value: {
          inputs: [
            {
              address: funder.seiAddress,
              coins: [
                {
                  denom: 'usei',
                  amount: totalAmount,
                },
              ],
            },
          ],
          outputs: users.slice(indexStart, indexStart + 10).map((user) => ({
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
        amount: coins(45000, 'usei'),
        gas: "300000",
      };

      // Sign and broadcast the message.
      const result = await funder.seiWallet.signingClient.signAndBroadcast(funder.seiAddress, [msgMultiSend], fee);
      console.log("Broadcast result:", result);
      indexStart+= 10;
    }
  }

  async fundAddressesOnSei(funder: SeiUser, users: SeiUser[], amount = '1000000'){
      const totalAmount = (BigInt(amount) * BigInt(users.length)).toString();
      const msgMultiSend = {
        typeUrl: "/cosmos.bank.v1beta1.MsgMultiSend",
        value: {
          inputs: [
            {
              address: funder.seiAddress,
              coins: [
                {
                  denom: 'usei',
                  amount: totalAmount,
                },
              ],
            },
          ],
          outputs: users.map((user) => ({
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

      // Sign and broadcast the message.
     const result = await funder.seiWallet.signingClient.signAndBroadcast(funder.seiAddress, [msgMultiSend],  fee);
  }

  async fundMultipleAddressesOnSei(recipients: SeiUser[], tokenName = 'usei', amount = '10000000') {
    // 1. Get the sender (admin) address.
    let {stdout: adminAddr} = await exec(`seid keys show admin -a`);
    const sender = adminAddr.trim();

    const msgs = recipients.map(recipient => ({
      '@type': '/cosmos.bank.v1beta1.MsgSend',
      'from_address': sender,
      'to_address': recipient.seiAddress,
      'amount': [
        {
          'denom': tokenName,
          'amount': amount,
        }
      ]
    }));

    const tx = {
      body: {
        messages: msgs,
        memo: '',
        timeout_height: '0',
        extension_options: [],
        non_critical_extension_options: []
      },
      auth_info: {
        signer_infos: [],
        fee: {
          amount: [
            {
              denom: tokenName,
              amount: '1450000'
            }
          ],
          gas_limit: '5500000'
        }
      },
      signatures: []
    };

    const txFile = 'tx.json';
    await fs.writeFile(txFile, JSON.stringify(tx, null, 2));
    const signCommand = `seid tx sign ${txFile} --from admin --chain-id sei -y > signed${txFile}`;
    await exec(signCommand);
    const options = { maxBuffer: 1024 * 1024 };
    const broadcastCommand = `seid tx broadcast signed${txFile} --broadcast-mode block --output json`;
    const {stdout} = await exec(broadcastCommand);
    await waitFor(1);
    return JSON.parse(stdout);
  }

  async fundAdminOnEvm() {
    if (await this.isDocker()) {
      const {stdout} = await exec(`docker exec sei-node-0 /bin/bash -c 'export PATH=$PATH:/root/go/bin:/root/.foundry/bin && printf "12345678\n" | seid keys show admin -a'`);
      await exec(`docker exec sei-node-0 /bin/bash -c 'export PATH=$PATH:/root/go/bin:/root/.foundry/bin && printf "12345678\n" | seid tx bank send ${stdout} ${this.adminAddress} 1000000000000usei --fees 24500usei -y'`);
    } else {
      const {stdout} = await exec(`seid keys show admin -a`);
      await exec(`seid tx bank send ${stdout} ${this.adminAddress} 1000000000000usei --fees 24500usei -y`);
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
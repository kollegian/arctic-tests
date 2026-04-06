import {SeiUser, UserFactory} from '../../../shared/User';
import testConfig from '../../../config/testConfig.json';
import IBC from './IBC';
import {ContractTransactionReceipt, ethers} from 'ethers';
import ibcAbi from './ibcAbi.json';
import {returnExpect} from '../bank/utils';
import {execCommandAndReturnJson} from '../../../shared/utils/cliUtils';
import {waitFor} from '../../../shared/utils/helpers';
import {getQueryClient} from '../tokenfactory/helpers';
import {
  abi,
  decodeTxInput,
  mintNftOnSeiRuntime,
  queryErc721PointerContractAddress
} from '../../tokens/utils/cosmosUtils';
import bankAbi from './bankAbi.json';
import {coins, SigningStargateClient} from '@cosmjs/stargate';
import {coin, DirectSecp256k1HdWallet} from '@cosmjs/proto-signing';
import {stringToPath} from '@cosmjs/crypto';
import {TestNFT, TestNFT__factory} from '../../tokens/typechain-types';
import ContractFactory from '../../tokens/artifacts/contracts/TestNFT.sol/TestNFT.json'
import util from 'node:util';
import RPCClient from '../../tokens/utils/RPCClient'


const rpcEndpoint = 'https://rpc-testnet.sei-apis.com';
const restEndpoint = 'https://rest-testnet.sei-apis.com';
const evmEndpoint = 'https://evm-rpc-testnet.sei-apis.com';
const counterpartyRestEndpoint = 'https://lcd.osmotest5.osmosis.zone/';
const BANK_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000001001';
const IBC_PRECOMPILE_ADDRESS = '0x0000000000000000000000000000000000001009';
const exec = util.promisify(require('node:child_process').exec);

const retries = 30;
let expect: Chai.ExpectStatic;

describe('IBC Tests', function () {
  this.timeout(5 * 60 * 1000);
  let sender: SeiUser;
  let admin: SeiUser;
  // const sourceChannel = 'channel-101';
  // const counterpartyChannel = 'channel-29';
  const sourceChannel = 'channel-67';
  const counterpartyChannel = 'channel-1650';
  let ibcPrecompile: ethers.Contract;
  let bankPrecompile: ethers.Contract;
  const aliceTokenFactoryDenom = 'factory/sei1dg8unurclh6p05tu64nsth5642mm6gx5nt86hk/test';
  const wrongChannel = 'channel-100';
  const ibcModuleAddress = 'sei1yy0yvsehqw8f3ue9flnn2m40qx3y7efd3gznx0';
  const aliceMnemonic = 'frozen shift keen weather harbor input circle level eagle devote frown blush winter aunt relax address cave million drift inform dove unhappy museum stem';
  let pointerContract: ethers.Contract;
  let ibc: IBC;
  let erc721Contract: TestNFT;
  const pointerAddress = 'sei1e9p8m36ntlfzgkpt4jz3d6hcnazppl7qh5z2gz8nv72p4xnj7nzqegrvpx';

  before('Initializes users', async () => {
    expect = await returnExpect();
    sender = new SeiUser(rpcEndpoint, evmEndpoint, restEndpoint);
    admin = new SeiUser(rpcEndpoint, evmEndpoint, restEndpoint);
    await sender.initialize(aliceMnemonic, 'alice');
    await admin.initialize(testConfig.mnemonic, 'admin', false);

    ibcPrecompile = new ethers.Contract(IBC_PRECOMPILE_ADDRESS, ibcAbi, admin.evmWallet.wallet);
    bankPrecompile = new ethers.Contract(BANK_PRECOMPILE_ADDRESS, bankAbi.abi, admin.evmWallet.wallet);
    erc721Contract = new ethers.Contract(
      '0x088f16c99d47cc1717d8e78Ba31374b252b176e7',
      ContractFactory.abi,
      admin.evmWallet.wallet
    ) as unknown as TestNFT;
    ibc = new IBC(counterpartyRestEndpoint, 'osmo', sourceChannel, ibcPrecompile);
  });

  const denoms = ['usei', aliceTokenFactoryDenom];
  for (const denom of denoms) {
    it(`Alice can initiate a transfer from sei to destination chain on sei runtime for ${denom}`, async () => {
      const aliceOnDestBalance = await ibc.getBalanceOnDestinationChain(admin, denom, counterpartyChannel);
      const ibcTransfer = await ibc.sendIbcTransferMessageOnSei(admin, sourceChannel, admin, denom);
      const alicePostBalance = await ibc.waitForBalanceUpdate(aliceOnDestBalance, admin, denom, counterpartyChannel);
      expect(Number(alicePostBalance)).to.be.eq(Number(aliceOnDestBalance) + 1000);
    });

    it(`Alice can initiate a transfer from sei to destination chain on evm runtime for ${denom} with timeout`, async () => {
      const aliceOnDestBalance = await ibc.getBalanceOnDestinationChain(admin, denom, counterpartyChannel);
      const ibcTransfer = await ibc.sendIbcMessageOnEvmRuntimeWithTimeout(sourceChannel, admin, admin, denom);
      const receipt = await ibcTransfer.wait();
      const alicePostBalance = await ibc.waitForBalanceUpdate(aliceOnDestBalance, admin, denom, counterpartyChannel);
      expect(Number(alicePostBalance)).to.be.eq(Number(aliceOnDestBalance) + 1000);
    });

    it(`Alice can initiate a transfer from sei to destination chain on evm runtime for ${denom} with default timeout`, async () => {
      const aliceOnDestBalance = await ibc.getBalanceOnDestinationChain(admin, denom, counterpartyChannel);
      const ibcTransfer = await ibc.sendIbcMessageWithDefaultTimeout(sourceChannel, admin, admin, denom);
      const receipt = await ibcTransfer.wait();
      const alicePostBalance = await ibc.waitForBalanceUpdate(aliceOnDestBalance, admin, denom, counterpartyChannel);
      expect(Number(alicePostBalance)).to.be.eq(Number(aliceOnDestBalance) + 1000);
    });

    it.skip(`Alice can initiate a transfer from sei to destination chain on evm runtime for ${denom} with 0x addresses`, async () => {
      const aliceOnDestBalance = await ibc.getBalanceOnDestinationChain(admin, denom, counterpartyChannel);
      const aliceBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      const ibcTransfer = await ibc.sendIbcMessageOnEvmRuntimeWithTimeout(sourceChannel, admin, admin, denom, true);
      const receipt = await ibcTransfer.wait();
      const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      const alicePostBalanceOnDest = await ibc.waitForBalanceUpdate(aliceOnDestBalance, admin, denom, counterpartyChannel);
      expect(Number(alicePostBalanceOnDest)).to.be.eq(Number(aliceOnDestBalance) + 1000);
    });

    it.skip(`Alice can initiate a transfer from sei to destination chain on sei runtime for ${denom} with 0x addresses with timeout`, async () => {
      const aliceOnDestBalance = await ibc.getBalanceOnDestinationChain(admin, denom, counterpartyChannel);
      const ibcTransfer = await ibc.sendIbcTransferMessageOnSei(admin, sourceChannel, admin, denom, admin.evmAddress);
      const alicePostBalance = await ibc.waitForBalanceUpdate(aliceOnDestBalance, admin, denom, counterpartyChannel);
      expect(Number(alicePostBalance)).to.be.eq(Number(aliceOnDestBalance) + 1000);
    });

    it.skip(`Alice can initiate a transfer from sei to destination chain on evm runtime for ${denom} with 0x addresses and default timeout`, async () => {
      const aliceOnDestBalance = await ibc.getBalanceOnDestinationChain(admin, denom, counterpartyChannel);
      const ibcTransferTx = await ibc.sendIbcMessageWithDefaultTimeout(sourceChannel, admin, admin, denom, true);
      const receipt = await ibcTransferTx.wait();
      const alicePostBalance = await ibc.waitForBalanceUpdate(aliceOnDestBalance, admin, denom, counterpartyChannel);
      expect(Number(alicePostBalance)).to.be.eq(Number(aliceOnDestBalance) + 1000);
    });

    it(`Alice can initiate a failing transfer to destination chain for ${denom} and state is not updated on sei runtime`, async () => {
      const aliceBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      try {
        const failingTransfer = await ibc.sendIbcTransferMessageOnSei(admin, wrongChannel, admin, denom);
      } catch (e: any) {
      }
      const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      if (denom === 'usei') {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance) - 21000);
      } else {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance));
      }
    });

    it(`Alice can initiate a failing transfer to destination chain for ${denom} on evm runtime with timeout and the state is not updated`, async () => {
      const aliceBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      try {
        const failingTransfer = await ibc.sendIbcMessageOnEvmRuntimeWithTimeout(wrongChannel, admin, admin, denom);
        const receipt = await failingTransfer.wait();
      } catch (e: any) {
      }
      const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      if (denom === 'usei') {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance) - 3000);
      } else {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance));
      }
    });

    it(`Alice can initiate a failing transfer to destination chain for ${denom} on evm runtime with default timeout and the state is not updated`, async () => {
      const aliceBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      try {
        const failingTransfer = await ibc.sendIbcMessageWithDefaultTimeout(wrongChannel, admin, admin, denom);
        const receipt = await failingTransfer.wait();
      } catch (e: any) {
      }
      const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      if (denom === 'usei') {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance) - 3000);
      } else {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance));
      }
    });

    it(`Alice can initiate a failing transfer to destination chain for ${denom} on evm runtime with 0x addresses and the state is not updated with timeout`, async () => {
      const aliceBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      try {
        const failingTransfer = await ibc.sendIbcMessageOnEvmRuntimeWithTimeout(wrongChannel, admin, admin, denom, true);
        const receipt = await failingTransfer.wait();
      } catch (e: any) {
      }
      const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      if (denom === 'usei') {
        const expectedBalance = Number(aliceBalance) - 3000;
        expect(Number(alicePostBalance)).to.be.eq(expectedBalance);
      } else {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance));
      }
    });

    it(`Alice can initiate a failing transfer to destination chain for ${denom} on sei runtime with 0x addresses and the state is not updated`, async () => {
      const aliceBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      try {
        const failingTransfer = await ibc.sendIbcTransferMessageOnSei(admin, wrongChannel, admin, denom, admin.evmAddress);
      } catch (e: any) {
      }
      const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      if (denom === 'usei') {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance) - 21000);
      } else {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance));
      }
    });

    it(`Alice can initiate a failing transfer to destination chain for ${denom} on evm runtime with 0x addresses and the state is not updated with default timeout`, async () => {
      await waitFor(1);
      const aliceBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      try {
        const failingTransfer = await ibc.sendIbcMessageWithDefaultTimeout(wrongChannel, admin, admin, denom, true);
        const receipt = await failingTransfer.wait();
      } catch (e: any) {
      }
      const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, denom);
      if (denom === 'usei') {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance) - 3000);
      } else {
        expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance));
      }
    });
  }

  it('Alice cant initiate a transfer for more than her balance on evm runtime', async () => {
    const aliceBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    const amount = Number(aliceBalance) + 1000;
    try {
      const ibcTransfer = await ibc.sendIbcMessageWithDefaultTimeout(sourceChannel, admin, admin, aliceTokenFactoryDenom, true, '', amount.toString());
      const receipt = await ibcTransfer.wait();
    } catch (e: any) {
    }
    const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance));
  });

  it('Alice cant initiate transfer on evm runtime for negative amounts', async () => {
    const aliceBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    try {
      const ibcTransfer = await ibc.sendIbcMessageWithDefaultTimeout(sourceChannel, admin, admin, aliceTokenFactoryDenom, true, '', '-100000');
    } catch (e: any) {
    }
    const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    expect(Number(alicePostBalance)).to.be.eq(Number(aliceBalance));
  });

  it('Alice cant initiate a transfer with wrong timeout on evm runtime', async () => {
    const alicePreBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    const timeoutTimestamp = BigInt(Math.floor(Date.now() / 1000 - 1000)) * BigInt(1e9);
    const currentHeight = await ibc.getLatestDestinationBlock();
    const revisionHeight = currentHeight + 50;
    const toAddress = await ibc.generateReceiverAddress(admin);
    try {
      const tx = await ibc.ibcContract.connect(sender.evmWallet.wallet).transfer(
        toAddress,
        'transfer',
        sourceChannel,
        aliceTokenFactoryDenom,
        '100000',
        5,
        revisionHeight,
        timeoutTimestamp,
        'memo',
        {gasLimit: 1000000}
      );
      const receipt = await tx.wait();
    } catch (e: any) {
    }

    const aliceAfterBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    expect(Number(aliceAfterBalance)).to.be.eq(Number(alicePreBalance));
  });

  it('Alice can initiate a transfer with very little timeout seconds and the funds are returned to Alice', async () => {
    const wrongSourceChannel = 'channel-100';
    const alicePreBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    // Sets 5 seconds
    const timeoutTimestamp = BigInt(Math.floor(Date.now() / 1000 + 5)) * BigInt(1e9);
    const currentHeight = await ibc.getLatestDestinationBlock();
    const revisionHeight = currentHeight + 50;
    const toAddress = await ibc.generateReceiverAddress(admin);
    const tx = await ibc.ibcContract.connect(admin.evmWallet.wallet).transfer(
      toAddress,
      'transfer',
      sourceChannel,
      aliceTokenFactoryDenom,
      '100000',
      5,
      revisionHeight,
      timeoutTimestamp,
      'memo',
      {gasLimit: 1000000}
    );
    const receipt = await tx.wait();
    await waitFor(10);

    const aliceAfterBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    expect(Number(aliceAfterBalance)).to.be.eq(Number(alicePreBalance));
  });

  it('Alice can initiate a transfer with very little timeout height and the funds are returned to Alice', async () => {
    const alicePreBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    // Sets 5 seconds
    const timeoutTimestamp = BigInt(Math.floor(Date.now() / 1000 + 2500)) * BigInt(1e9);
    const currentHeight = await ibc.getLatestDestinationBlock();
    const revisionHeight = currentHeight + 1;
    const toAddress = await ibc.generateReceiverAddress(admin);
    const tx = await ibc.ibcContract.connect(admin.evmWallet.wallet).transfer(
      toAddress,
      'transfer',
      sourceChannel,
      aliceTokenFactoryDenom,
      '100000',
      5,
      revisionHeight,
      timeoutTimestamp,
      'memo',
      {gasLimit: 1000000}
    );
    const receipt = await tx.wait();
    await waitFor(10);

    const aliceAfterBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    expect(Number(aliceAfterBalance)).to.be.eq(Number(alicePreBalance));
  });

  it('Alice can receive an ibc transfer to 0x addresses with one hop on evm runtime', async () => {
    const senderAddress = await ibc.generateReceiverAddress(admin);
    const receiverBalance = await bankPrecompile.balance(admin.evmAddress, 'ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC');
    const preTotalIssuance = await execCommandAndReturnJson(`seid q bank total --denom ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC`);
    console.log('Pre receiver balance is ', receiverBalance.toString());
    console.log('Pre total issuance is ', preTotalIssuance.amount);
    const senderBalance = await execCommandAndReturnJson(`osmosisd q bank balances ${senderAddress} --denom uosmo`);
    console.log('Sender Balance before tx on osmo ', senderBalance);
    const memo = `{"forward":{"receiver":"${senderAddress}","port":"transfer","channel":"${sourceChannel}","timeout":600000000000,"retries":0}}`
    const transferTx = await ibc.sendIbcFromCounterparty(counterpartyChannel, admin.evmAddress, 'uosmo', '100000', memo);
    console.log(transferTx);
    const senderIntermediateBalance = await execCommandAndReturnJson(`osmosisd q bank balances ${senderAddress} --denom uosmo`);
    console.log('Sender Balance after tx on osmo ', senderIntermediateBalance);
    await waitFor(15);
    const senderPostBalance = await execCommandAndReturnJson(`osmosisd q bank balances ${senderAddress} --denom uosmo`);
    console.log(senderPostBalance);
    const receiverAfterBalance = await bankPrecompile.balance(admin.evmAddress, 'ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC');
    console.log(receiverAfterBalance);
    const postTotalIssuance = await execCommandAndReturnJson(`seid q bank total --denom ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC`)
    console.log('Post total issuance is ', postTotalIssuance.amount);
    expect(Number(senderPostBalance.amount)).to.be.eq(Number(senderBalance.amount) - 2000);
  });

  it('Alice can receive an ibc transfer to 0x addresses with one hop on evm runtime with sei address', async () => {
    const senderAddress = await ibc.generateReceiverAddress(admin);
    console.log(senderAddress);
    const receiverBalance = await bankPrecompile.balance(admin.evmAddress, 'ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC');
    const preTotalIssuance = await execCommandAndReturnJson(`seid q bank total --denom ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC`);
    console.log('Pre receiver balance is ', receiverBalance.toString());
    console.log('Pre total issuance is ', preTotalIssuance.amount);
    const senderBalance = await execCommandAndReturnJson(`osmosisd q bank balances ${senderAddress} --denom uosmo`);
    console.log(senderBalance);
    const memo = `{"forward":{"receiver":"${senderAddress}","port":"transfer","channel":"${sourceChannel}","timeout":600000000000,"retries":0}}`
    const transferTx = await ibc.sendIbcFromCounterparty(counterpartyChannel, admin.seiAddress, 'uosmo', '100000', memo);
    console.log(transferTx);
    await waitFor(2);
    await waitFor(15);
    const senderPostBalance = await execCommandAndReturnJson(`osmosisd q bank balances ${senderAddress} --denom uosmo`);
    console.log(senderPostBalance);
    const receiverAfterBalance = await bankPrecompile.balance(admin.evmAddress, 'ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC');
    console.log(receiverAfterBalance);
    const postTotalIssuance = await execCommandAndReturnJson(`seid q bank total --denom ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC`)
    console.log('Post total issuance is ', postTotalIssuance.amount);
    // expect(Number(senderPostBalance.amount)).to.be.eq(Number(senderBalance.amount) - 2000);
  });

  it('Alice can receive an ibc transfer to 0x addresses with one hop on evm runtime with sei address with cosmjs', async () => {
    const rpcEndpoint = 'https://rpc.osmotest5.osmosis.zone/';
    const osmoWallet = await DirectSecp256k1HdWallet.fromMnemonic(admin.seiWallet.wallet.mnemonic, {
      prefix: "osmo",
      hdPaths: [stringToPath('m/44\'/118\'/0\'/0/0')],
    });
    const osmoAddress = (await osmoWallet.getAccounts())[0].address;
    const signingClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, osmoWallet);

    const receiverBalance = await bankPrecompile.balance(admin.evmAddress, 'ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC');
    const preTotalIssuance = await execCommandAndReturnJson(`seid q bank total --denom ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC`);
    console.log('Pre receiver balance is ', receiverBalance.toString());
    console.log('Pre total issuance is ', preTotalIssuance.amount);
    const senderBalance = await execCommandAndReturnJson(`osmosisd q bank balances ${osmoAddress} --denom uosmo`);
    console.log(senderBalance);

    const timeoutTimestamp = (Date.now() + 10 * 60 * 1000) * 1_000_000;
    const timeoutHeight = (await admin.seiWallet.signingClient.getHeight()) + 50;
    const memo = `{"forward":{"receiver":"${osmoAddress}","port":"transfer","channel":"${sourceChannel}","timeout":600000000000,"retries":0}}`

    const msg = {
      sourcePort: 'transfer',
      sourceChannel: counterpartyChannel,
      token: {
        denom: 'uosmo',
        amount: '1000',
      },
      sender: (await osmoWallet.getAccounts())[0].address,
      receiver: admin.seiAddress,
      timeoutHeight: timeoutHeight,
      timeoutTimestamp: timeoutTimestamp,
      memo
    };

    const msgTransfer = {
      typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
      value: msg,
    };
    const tx = await signingClient.signAndBroadcast((await osmoWallet.getAccounts())[0].address, [msgTransfer], { amount: coins(2000, "uosmo"), gas: "200000" });
    console.log(tx);

    await waitFor(2);
    await waitFor(15);
    const senderPostBalance = await execCommandAndReturnJson(`osmosisd q bank balances ${osmoAddress} --denom uosmo`);
    console.log(senderPostBalance);
    const receiverAfterBalance = await bankPrecompile.balance(admin.evmAddress, 'ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC');
    console.log(receiverAfterBalance);
    const postTotalIssuance = await execCommandAndReturnJson(`seid q bank total --denom ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC`)
    console.log('Post total issuance is ', postTotalIssuance.amount);
    // expect(Number(senderPostBalance.amount)).to.be.eq(Number(senderBalance.amount) - 2000);
  });

  it.skip('Alice can receive a hopped ibc transfer into 0x address', async () => {
    const alicePreBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    const memo = `{"forward":{"receiver":"${admin.evmAddress}","port":"transfer","channel":"${counterpartyChannel}","timeout":600000000000,"retries":0}}`
    const transferTx = await ibc.sendIbcMessageWithDefaultTimeout(sourceChannel, admin, admin, aliceTokenFactoryDenom, false, memo);
    const receipt = await transferTx.wait();
    const aliceIntermediateBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    await waitFor(10);
    const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    console.log(alicePreBalance);
    console.log(aliceIntermediateBalance);
    console.log(alicePostBalance);
  });

  it.skip('0x addresses can receive tokens that dont have pointer deployed on evm runtime', async () => {
    const unPointerTokenOnOsmosis = 'ibc/90D6644505208CB37F66D8FFC50FCFC64D04BE0F1EE2CCB3F0709C37022767BE';
    const unpointerToken = 'factory/sei1dg8unurclh6p05tu64nsth5642mm6gx5nt86hk/test2';
    const amount = '1000';
    const preBalance = await execCommandAndReturnJson(`seid q bank balances ${admin.seiAddress} --denom ${unpointerToken}`);
    const tx = await ibc.sendIbcFromCounterparty(counterpartyChannel, admin.evmAddress, unPointerTokenOnOsmosis, amount, 'test');
    await waitFor(5);
    const userBalance = await execCommandAndReturnJson(`seid q bank balances ${admin.seiAddress} --denom ${unpointerToken}`);
    expect(Number(userBalance.amount)).to.be.eq(Number(preBalance.amount) + Number(amount));
  });

  it.skip('Alice can initiate an ibc transfer on sei runtime and evm runtime at the same time with tokenfactory denom', async () => {
    const alicePreBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    const osmoPreBalance = await ibc.getBalanceOnDestinationChain(admin, aliceTokenFactoryDenom, counterpartyChannel);
    console.log('Osmo pre balance ', osmoPreBalance);
    const delayed = async () =>{
      await waitFor(0.4);
      return ibc.sendIbcMessageWithDefaultTimeout(sourceChannel, admin, admin, aliceTokenFactoryDenom)
    }
    const results = await Promise.all([
      ibc.sendIbcTransferMessageOnSei(admin, sourceChannel, admin, aliceTokenFactoryDenom),
      delayed()
    ]);
    const receipt = await results[1].wait();
    console.log(results[0]);
    console.log(receipt);

    const alicePostBalance = await bankPrecompile.balance(admin.evmAddress, aliceTokenFactoryDenom);
    console.log(alicePreBalance);
    console.log(alicePostBalance);
    await waitFor(4);
    const osmoBalance = await ibc.getBalanceOnDestinationChain(admin, aliceTokenFactoryDenom, counterpartyChannel);
    console.log('osmo after balance', osmoBalance);
  });

  it.skip('Unassociated users can receive funds through ibc to 0x addresses', async () => {
    const userBeforeBalance = await execCommandAndReturnJson(`osmosisd q bank balances osmo1dg8unurclh6p05tu64nsth5642mm6gx5ku9u89 --denom uosmo`);
    const unassociatedAddress = new SeiUser(rpcEndpoint, evmEndpoint, restEndpoint);
    await unassociatedAddress.initialize('', 'unassoc', false);
    const tx = await ibc.sendIbcFromCounterparty(counterpartyChannel, unassociatedAddress.evmAddress, 'uosmo', '10000' , 'test');
    await waitFor(5);
    const userAfterBalance = await execCommandAndReturnJson(`osmosisd q bank balances osmo1dg8unurclh6p05tu64nsth5642mm6gx5ku9u89 --denom uosmo`);
    await UserFactory.fundAddressOnSei(unassociatedAddress.seiAddress);
    await unassociatedAddress.seiWallet.associate();

    //After association users will see funds
    const userBalance = await bankPrecompile.balance(unassociatedAddress.evmAddress, 'ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC');
    expect(userBalance.toString()).to.be.eq('10000');
  });

  it('Unexisting users funds are returned to the sender', async () => {
    const totalIssuance = await execCommandAndReturnJson(`seid q bank total --denom ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC`);
    console.log(totalIssuance);
    const userBeforeBalance = await execCommandAndReturnJson(`osmosisd q bank balances osmo1dg8unurclh6p05tu64nsth5642mm6gx5ku9u89 --denom uosmo`);
    const tx = await ibc.sendIbcFromCounterparty(counterpartyChannel, admin.seiAddress.slice(0, 12), 'uosmo', '20000' , 'test');
    console.log(tx);
    await waitFor(10);
    const userAfterBalance = await execCommandAndReturnJson(`osmosisd q bank balances osmo1dg8unurclh6p05tu64nsth5642mm6gx5ku9u89 --denom uosmo`);
    const totalIssuanceAfter = await execCommandAndReturnJson(`seid q bank total --denom ibc/36D21D26E6DF4D9903D6EE82C6082126B360691561BDC5E2F202DE8568FDDECC`)
    console.log(totalIssuanceAfter);
    console.log(userAfterBalance);
    console.log(userBeforeBalance);
  });

  //Read tests
  let rpcClient: RPCClient;
  let transferReceipt: ContractTransactionReceipt;
  it('Given that a cw721 transfer event happening on the same block of an ibc transfer, synthetic logs return events', async () => {
    rpcClient = new RPCClient(admin.evmWallet.signingClient);
    const tx = await erc721Contract.safeMint(admin.evmAddress, '3');
    await tx.wait();
    console.info('Minted token');

    const {stdout} = await exec(`seid tx evm register-cw-pointer ERC721 ${await erc721Contract.getAddress()} --from admin --fees 24200usei --broadcast-mode block -y`);
    await waitFor(1);

    const results = await Promise.all([
      admin.seiWallet.cosmWasmSigningClient.execute(
        admin.seiAddress,
        pointerAddress,
        {transfer_nft: {recipient: sender.seiAddress, token_id: '3'}},
        'auto'
      ),
      ibc.sendIbcMessageWithDefaultTimeout(sourceChannel, admin, admin, aliceTokenFactoryDenom)
    ]);

    transferReceipt = await results[1].wait();

    const logParams = {
      fromBlock: ethers.toQuantity(transferReceipt.blockNumber - 2),
      toBlock: ethers.toQuantity(transferReceipt.blockNumber + 3),
      // address: await erc721Contract.getAddress(),
    };
    const logs = await rpcClient.sei_getLogs(logParams);
    console.log(logs);
  });

  it('Given that an erc721 transfer event happening on the same block of an ibc transfer, evm logs return events', async () => {
    const [ercTransfer, ibcTransfer] = await Promise.all([
      ibc.sendIbcMessageWithDefaultTimeout(sourceChannel, admin, admin, aliceTokenFactoryDenom),
      erc721Contract.connect(sender.evmWallet.wallet).transferFrom(sender.evmAddress, admin.evmAddress, '3')
    ])
    const receipts = await Promise.all([ercTransfer.wait(), ibcTransfer.wait()]);
    console.log(receipts);
    const logParams = {
      fromBlock: ethers.toQuantity(receipts[0].blockNumber - 2),
      toBlock: ethers.toQuantity(receipts[1].blockNumber + 3),
      // address: await erc721Contract.getAddress(),
    };
    const logs = await rpcClient.sei_getLogs(logParams);
    console.log(logs);
  });

  const endpoints = ['eth_getBlockByNumber', 'eth_getBlockByHash', 'sei_getBlockByNumber', 'sei_getBlockByHash']
  for(const endpoint of endpoints) {
    it('Logs return events from the blocks that has ibc txs', async () =>{
      const topic = ethers.id('Transfer(address,address,uint256)');
      const rpcResult = await rpcClient.checkAndReturnRpcCallResults(endpoint, transferReceipt, topic);
      expect(rpcResult.length).to.equal(2, 'Transactions found when none was expected');
      if (endpoint.includes('Logs')) {
        for (const log of rpcResult) {
          const parsedLogs = erc721Contract.interface.parseLog(log);
          console.log(parsedLogs);
        }
      } else {
        for (const tx of rpcResult) {
          //For synthetic events use this
          try {
            const decodedInput = await decodeTxInput(tx.input);
            console.log(decodedInput);
          } catch (e: any) {
            const decoded = erc721Contract.interface.parseTransaction({data: tx.input});
            console.log(decoded);
          }
        }
      }
    })
  }

  it.only('Sends from atlantic - 2 to arctic 1 to 0x addresses', async () =>{
    const sourceChannel = 'channel-105';
    const counterpartyChannel = 'channel-33';
    const ibc = new IBC('https://rest-arctic-1.sei-apis.com', 'sei', sourceChannel, ibcPrecompile);
    const preBalance = await ibc.getBalanceOnDestinationChain(admin, aliceTokenFactoryDenom, counterpartyChannel);
    const transferTxOnEvm = await ibc.sendIbcMessageOnEvmRuntimeWithTimeout(sourceChannel, admin, admin, aliceTokenFactoryDenom, true);
    const receipt = await transferTxOnEvm.wait();
    console.log(receipt);
    console.log('Tx on evm fired with timeout');
    await waitFor(10);
    const afterBalance = await ibc.getBalanceOnDestinationChain(admin, aliceTokenFactoryDenom, counterpartyChannel);
    console.log(preBalance);
    console.log(afterBalance);
    console.log(aliceTokenFactoryDenom);
    // Sends ibc from sei
    const transferTxOnSei = await ibc.sendIbcTransferMessageOnSei(admin, sourceChannel, admin, aliceTokenFactoryDenom, admin.evmAddress);
    console.log(transferTxOnSei);
    await waitFor(10);
    const afterBalanceOnSei = await ibc.getBalanceOnDestinationChain(admin, aliceTokenFactoryDenom, counterpartyChannel);
    console.log(afterBalanceOnSei);
    console.log('Tx from sei fired');
    const transferEvmOn2 = await ibc.sendIbcMessageWithDefaultTimeout(sourceChannel, admin, admin, aliceTokenFactoryDenom, true);
    const receiptt = await transferEvmOn2.wait();
    console.log(receiptt);
    await waitFor(10);
    const afterBalanceOn2 = await ibc.getBalanceOnDestinationChain(admin, aliceTokenFactoryDenom, counterpartyChannel);
    console.log(afterBalanceOn2);
    console.log('Tx on evm fired with default');
  });
});
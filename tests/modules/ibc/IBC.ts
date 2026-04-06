import {SigningStargateClient} from '@cosmjs/stargate';
import {SeiUser} from '../../../shared/User';
import {DirectSecp256k1HdWallet} from '@cosmjs/proto-signing';
import {sha256, stringToPath} from '@cosmjs/crypto';
import {toHex} from '@cosmjs/encoding';
import {waitFor} from '../../../shared/utils/helpers';
import {ethers} from 'ethers';
import util from 'node:util';
import {
  instantiateNftContract,
  queryCwPointerContractAddress,
  uploadCodeToCosmos
} from '../../tokens/utils/cosmosUtils';

const exec = util.promisify(require('node:child_process').exec);

export default class IBC {
  signingClient!: SigningStargateClient;
  address!: string;
  counterpartyRestEndpoint: string;
  counterpartyDestChainName: string;
  sourceChannel: string;
  ibcContract: ethers.Contract;

  constructor(counterPartyRestEndpoint: string, counterpartyDestChainName: string, sourceChannel: string, ibcContract: ethers.Contract) {
    this.counterpartyRestEndpoint = counterPartyRestEndpoint;
    this.counterpartyDestChainName = counterpartyDestChainName;
    this.sourceChannel = sourceChannel;
    this.ibcContract = ibcContract;
  }

  async createIbcSigningClient(user: SeiUser) {
    this.signingClient = await SigningStargateClient.connectWithSigner(user.seiRpcEndpoint, user.seiWallet.wallet);
  }

  async generateReceiverAddress(user: SeiUser){
    const receiverWallet = await DirectSecp256k1HdWallet.fromMnemonic(user.seiWallet.wallet.mnemonic, {
      prefix: this.counterpartyDestChainName,
      hdPaths: [stringToPath('m/44\'/118\'/0\'/0/0')],
    });
    return (await receiverWallet.getAccounts())[0].address;
  }

  async getBalanceOnDestinationChain(receiver: SeiUser, tokenNameOnSourceChain: string, receivingChannel: string) {
    const addressOnDestinationChain = await this.generateReceiverAddress(receiver);
    const fullPath = `transfer/${receivingChannel}/${tokenNameOnSourceChain}`;
    const hash = sha256(Buffer.from(fullPath));
    const denomOnDestinationChain = `ibc/${toHex(hash).toUpperCase()}`;
    let response = await fetch(`${this.counterpartyRestEndpoint}/cosmos/bank/v1beta1/balances/${addressOnDestinationChain}?denom=${denomOnDestinationChain}`);
    const balances = await response.json();
    const balanceOfToken = balances.balances.find((b:any) => b.denom === denomOnDestinationChain);
    if(!balanceOfToken){
      return '0';
    }
    return balanceOfToken.amount;
  }

  async getLatestDestinationBlock(){
    const latestBlock = await fetch(`${this.counterpartyRestEndpoint}/cosmos/base/tendermint/v1beta1/blocks/latest`);
    const block = await latestBlock.json();
    return Number(block.block.header.height);
  }

  async sendIbcTransferMessageOnSei(user: SeiUser, sourceChannel: string, receiverUser: SeiUser, denom: string, isReceiverAddress = '', memo = '') {
    await this.createIbcSigningClient(user);
    //generate receiving chain address
    const receiverAddress = await this.generateReceiverAddress(receiverUser);
    const timeoutTimestamp = (Date.now() + 10 * 60 * 1000) * 1_000_000;
    const timeoutHeight = (await this.getLatestDestinationBlock()) + 50;

    const msg = {
      sourcePort: 'transfer',
      sourceChannel: sourceChannel,
      token: {
        denom: denom,
        amount: '1000',
      },
      sender: user.seiAddress,
      receiver: isReceiverAddress ? isReceiverAddress : receiverAddress,
      timeoutHeight: timeoutHeight,
      timeoutTimestamp: timeoutTimestamp,
      memo: memo
    };

    const msgTransfer = {
      typeUrl: '/ibc.applications.transfer.v1.MsgTransfer',
      value: msg,
    };
    return await this.signingClient.signAndBroadcast(user.seiAddress, [msgTransfer], user.seiWallet.fee, '');
  }

  async sendIbcMessageOnEvmRuntimeWithTimeout(channel: string, sender: SeiUser, receiver: SeiUser, denom: string, useEvmAddr = false, memo = 'test') {
    let toAddress = '';
    if (useEvmAddr){
      toAddress = receiver.evmAddress;
    } else {
      toAddress = await this.generateReceiverAddress(receiver);
    }
    const amount = ethers.parseUnits('0.001', 6);
    const timeoutTimestamp = BigInt(Math.floor(Date.now() / 1000 + 3600)) * BigInt(1e9);
    const currentHeight = await this.getLatestDestinationBlock();
    const revisionHeight = currentHeight + 50;
    const revisionNumber = 5;

    return await this.ibcContract.connect(sender.evmWallet.wallet).transfer(
      toAddress,
      'transfer',
      channel,
      denom,
      amount,
      revisionNumber,
      revisionHeight,
      timeoutTimestamp,
      memo,
      {gasLimit: 1000000}
    );
  }

  async sendIbcMessageWithDefaultTimeout(channel: string, sender: SeiUser, receiver: SeiUser, denom: string, isEvmAddress = false, memo = 'test', amount = '') {
    let toAddress = '';
    if(isEvmAddress){
      toAddress = receiver.evmAddress;
    } else {
      toAddress = await this.generateReceiverAddress(receiver);
    }
    const amountToSend = amount || ethers.parseUnits('0.001', 6);

    return await this.ibcContract.connect(sender.evmWallet.wallet).transferWithDefaultTimeout(
      toAddress,
      'transfer',
      channel,
      denom,
      amountToSend,
      memo,
      {gasLimit: 1000000}
    );
  }

  async queryLatestReceivedPacket(rpcEndpoint: string, channel: string) {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tx_search",
      params: {
        query: `recv_packet.packet_src_channel='${channel}'`,
        order_by: "desc",
        limit: 1
      }
    };
    const response = await fetch(rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await response.json();
  }

  async deployWasmToCosmos(user: SeiUser) {
    const {codeId} = await uploadCodeToCosmos('../tokens/wasm/cw2981_royalties.wasm', user.seiWallet.wallet, user.seiWallet.cosmWasmSigningClient);
    const {contractAddress} = await instantiateNftContract(user.seiAddress, user.seiWallet.cosmWasmSigningClient, 'CwNFT', 'CwNFT', codeId);
    return contractAddress;
  }

  async registerPointer(cw721ContractAddress: string, evmRpcEndpoint: string) {
    await exec(`seid tx evm register-evm-pointer CW721 ${cw721ContractAddress} --evm-rpc=${evmRpcEndpoint} --from admin -y`);
    await waitFor(2);
    return await queryCwPointerContractAddress(cw721ContractAddress);
  }

  async mintNftOnSeiRuntime(tokenId: string, cw721ContractAddress: string, user: SeiUser) {
    const mintMsg = {
      mint: {
        token_id: tokenId,
        owner: user.seiAddress,
        token_uri: `https://example.com/${tokenId}.json`,
        extension: {
          royalty_percentage: 10,
          royalty_payment_address: user.seiAddress,
        },
      },
    };
    return await user.seiWallet.cosmWasmSigningClient.execute(user.seiAddress, cw721ContractAddress, mintMsg, "auto");
  }

  async waitForBalanceUpdate(currentBalance: string, receiver: SeiUser, tokenNameOnSourceChain: string, counterpartyChannel: string) {
    const maxRetries = 10;
    let retry = 0;
    let balance = await this.getBalanceOnDestinationChain(receiver, tokenNameOnSourceChain, counterpartyChannel);
    while(currentBalance === balance){
      await waitFor(3);
      balance = await this.getBalanceOnDestinationChain(receiver, tokenNameOnSourceChain, counterpartyChannel);
      retry++;
      if(retry > maxRetries){
        throw new Error('Transfer wasnt received in 30 seconds.');
      }
    }
    return balance;
  }

  async sendIbcFromCounterparty(destinationChannel: string, receiverAddress: string, tokenName: string, amount: string, memo = '') {
    console.log('Firing tx');
    const tx = await exec(`osmosisd tx ibc-transfer transfer transfer channel-1650 ${receiverAddress} ${amount}${tokenName} --from admin --fees 2000uosmo --memo ${memo} -y`);
    console.log('Tx fired');
    return tx.stdout;
  }
}

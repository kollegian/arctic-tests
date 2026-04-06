import {DeliverTxResponse, GasPrice, SigningStargateClient, StdFee} from '@cosmjs/stargate';
import { ethers, HDNodeWallet, JsonRpcProvider, TransactionRequest, TransactionResponse } from 'ethers';
import { Coin, DirectSecp256k1HdWallet, EncodeObject, Registry } from '@cosmjs/proto-signing';
import { stringToPath } from '@cosmjs/crypto';
import { seiProtoRegistry } from '@sei-js/cosmos/encoding/stargate';
import { Querier } from "@sei-js/cosmos/rest";
import { coins } from '@cosmjs/amino';
import { Encoder } from '@sei-js/cosmos/encoding';
import {execCommandAndReturnJson, waitFor} from '../tokenfactory/helpers';
import util from 'node:util';
import {SigningCosmWasmClient} from '@cosmjs/cosmwasm-stargate';
const exec = util.promisify(require('node:child_process').exec);

export abstract class User<Wallet> {
  wallet!: Wallet;
  walletAddress = "";

  abstract signAndSend(messages: readonly EncodeObject[] | TransactionRequest): Promise<TransactionResponse | DeliverTxResponse>;
  abstract queryBalance(): Promise<Coin | BigInt>;
  abstract createRandomUser(rpcEndpoint: string, restEndpoint: string): Promise<Wallet>;
  abstract createUser(mnemonic: string, rpcEndpoint: string, restEndpoint: string): Promise<Wallet>;
  abstract isAssociated(): Promise<boolean>;
}

export class SeiUser {
  seiWallet: SeiWallet;
  evmWallet: EvmWallet;
  seiAddress!: string;
  evmAddress!: string;
  cli = new Cli();

  constructor(
    public seiRpcEndpoint: string,
    public evmRpcEndpoint: string,
    public restEndpoint: string
  ) {
    this.seiWallet = new SeiWallet();
    this.evmWallet = new EvmWallet();
  }

  async initialize(mnemonic = '', userName = '', toBeAddedToCli = false) {
    if (mnemonic) {
      // await this.cli.updateCliConfig(this.seiRpcEndpoint, 'atlantic-2');
      await this.seiWallet.createUser(mnemonic, this.seiRpcEndpoint, this.restEndpoint);
      await this.evmWallet.createUser(mnemonic, this.evmRpcEndpoint, this.restEndpoint);
      if(toBeAddedToCli) {
        console.log(`Adding user ${userName} to the cli as well`);
        await this.cli.createUser(userName, mnemonic);
      }
      this.seiAddress = this.seiWallet.walletAddress;
      this.evmAddress = this.evmWallet.walletAddress;
    } else {
      await this.seiWallet.createRandomUser(this.seiRpcEndpoint, this.restEndpoint);
      await this.evmWallet.createUser(this.seiWallet.wallet.mnemonic, this.evmRpcEndpoint, this.restEndpoint);
      if(toBeAddedToCli){
        console.log(`Adding user ${userName} to the cli as well`);
        await this.cli.createUser(userName, this.seiWallet.wallet.mnemonic);
      }
      this.seiAddress = this.seiWallet.walletAddress;
      this.evmAddress = this.evmWallet.walletAddress;
    }
  }
}

export class SeiWallet extends User<DirectSecp256k1HdWallet> {
  signingClient!: SigningStargateClient;
  cosmWasmSigningClient!: SigningCosmWasmClient;
  restEndpoint!: string;
  fee: StdFee = { amount: coins(21000, "usei"), gas: "200000" };

  updateFee(newFee: StdFee){
    this.fee = newFee;
  }
  async createUser(mnemonic: string, rpcEndpoint: string, restEndpoint: string): Promise<DirectSecp256k1HdWallet> {
    this.wallet = await this.createHdWallet(mnemonic);
    this.signingClient = await this.createSigningClient(rpcEndpoint, this.wallet);
    this.cosmWasmSigningClient = await SigningCosmWasmClient.connectWithSigner(rpcEndpoint, this.wallet, {gasPrice: GasPrice.fromString("0.25usei")});
    this.walletAddress = (await this.wallet.getAccounts())[0].address;
    this.restEndpoint = restEndpoint;
    return this.wallet;
  }

  async createRandomUser(rpcEndpoint: string, restEndpoint: string): Promise<DirectSecp256k1HdWallet> {
    if (this.wallet) throw new Error('Wallet already assigned');
    this.wallet = await DirectSecp256k1HdWallet.generate(12, { prefix: "sei" });
    this.signingClient = await this.createSigningClient(rpcEndpoint, this.wallet);
    this.cosmWasmSigningClient = await SigningCosmWasmClient.connectWithSigner(rpcEndpoint, this.wallet, {gasPrice: GasPrice.fromString("0.25usei")});
    this.walletAddress = (await this.wallet.getAccounts())[0].address;
    this.restEndpoint = restEndpoint;
    return this.wallet;
  }

  async signAndSend(messages: readonly EncodeObject[], memo='tx'): Promise<DeliverTxResponse> {
    return await this.signingClient.signAndBroadcast(this.walletAddress, messages, this.fee, memo);
  }

  async queryBalance(): Promise<Coin> {
    return await this.signingClient.getBalance(this.walletAddress, 'usei');
  }

  async isAssociated(): Promise<boolean> {
    const result = await Querier.evm.EVMAddressBySeiAddress(
      { sei_address: this.walletAddress },
      { pathPrefix: this.restEndpoint }
    );
    return result.associated;
  }

  async associate(): Promise<DeliverTxResponse> {
    const msgAssociate = Encoder.evm.MsgAssociate.fromPartial({
      sender: this.walletAddress,
      custom_message: 'customMessage',
    });
    const msgSend = { typeUrl: `/${Encoder.evm.MsgAssociate.$type}`, value: msgAssociate };
    return await this.signAndSend([msgSend]);
  }

  private async createHdWallet(mnemonic: string): Promise<DirectSecp256k1HdWallet> {
    return await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
      prefix: "sei",
      hdPaths: [stringToPath('m/44\'/118\'/0\'/0/0')],
    });
  }

  private async createSigningClient(rpcEndpoint: string, wallet: DirectSecp256k1HdWallet): Promise<SigningStargateClient> {
    const registry = new Registry(seiProtoRegistry);
    return await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet, { registry });
  }
}

export class EvmWallet extends User<HDNodeWallet> {
  signingClient!: JsonRpcProvider;
  restEndpoint!: string;

  async createUser(mnemonic: string, rpcEndpoint: string, restEndpoint: string): Promise<HDNodeWallet> {
    this.wallet = this.createHdNodeWallet(mnemonic).connect(new JsonRpcProvider(rpcEndpoint));
    this.signingClient = new JsonRpcProvider(rpcEndpoint);
    this.walletAddress = await this.wallet.getAddress();
    this.restEndpoint = restEndpoint;
    return this.wallet;
  }

  async createRandomUser(rpcEndpoint: string, restEndpoint: string): Promise<HDNodeWallet> {
    this.signingClient = new JsonRpcProvider(rpcEndpoint);
    this.wallet = ethers.Wallet.createRandom().connect(this.signingClient);
    this.walletAddress = await this.wallet.getAddress();
    this.restEndpoint = restEndpoint;
    return this.wallet;
  }

  async signAndSend(tx: TransactionRequest): Promise<TransactionResponse> {
    return await this.wallet.sendTransaction(tx);
  }

  async queryBalance() {
    return await this.signingClient.getBalance(this.walletAddress);
  }

  async isAssociated(): Promise<boolean> {
    const result = await Querier.evm.SeiAddressByEVMAddress(
      { evm_address: this.walletAddress },
      { pathPrefix: this.restEndpoint }
    );
    return result.associated;
  }

  private createHdNodeWallet(mnemonic: string): HDNodeWallet {
    return ethers.HDNodeWallet.fromPhrase(mnemonic, '', 'm/44\'/118\'/0\'/0/0');
  }
}

export class Cli {
  adminAddress = "sei1dg8unurclh6p05tu64nsth5642mm6gx5nt86hk";
  adminMnemonic = "cover brand danger absent gas worth sustain rural powder auction shadow find merge domain promote glimpse burger embody favorite lake rain plate present soda";

  async checkAdmin(){
    try{
      const {stdout, stderr} = await exec(`seid keys show admin -a`);
      if(stdout !== this.adminAddress){
        console.log('Deleting old admin key');
        await exec(`seid keys delete admin -y`);
        await waitFor(0.1);
        console.log('Old admin key deleted');
      }
    } catch (e: any){
      console.log(e.message);
      await execCommandAndReturnJson(`echo "${this.adminMnemonic}" | seid keys add admin --recover`);
    }
  }

  async updateCliConfig(rpcEndpoint: string, chainId: string){
    console.log('Updating cli config with new rpc endpoint and chain id');
    await exec(`seid config node ${rpcEndpoint}`);
    await waitFor(0.1);
    await exec(`seid config chain-id ${chainId}`);
    // await this.checkAdmin();
  }

  async createUser(userName: string, mnemonic: string) {
    try{
      const {stdout} = await exec(`seid keys show ${userName} -a`);
      console.log('Key exists, deleting it.');
      await waitFor(1);
      await exec(`seid keys delete ${userName} -y`);
      await waitFor(1);
      await execCommandAndReturnJson(`echo ${mnemonic} | seid keys add ${userName} --recover`);
    } catch(e: any) {
      return await execCommandAndReturnJson(`echo ${mnemonic} | seid keys add ${userName} --recover`);
    }
  }
}

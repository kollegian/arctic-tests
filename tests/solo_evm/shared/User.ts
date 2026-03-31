import { ethers, HDNodeWallet, JsonRpcProvider, Wallet } from 'ethers';

export class User {
  wallet: HDNodeWallet;
  provider: JsonRpcProvider;
  address: string;

  private constructor(wallet: HDNodeWallet, provider: JsonRpcProvider) {
    this.wallet = wallet;
    this.provider = provider;
    this.address = wallet.address;
  }

  static async create(rpcUrl: string): Promise<User> {
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = Wallet.createRandom().connect(provider) as HDNodeWallet;
    return new User(wallet, provider);
  }

  static async fromPrivateKey(privateKey: string, rpcUrl: string): Promise<User> {
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider) as HDNodeWallet;
    return new User(wallet, provider);
  }

  static async fromMnemonic(mnemonic: string, rpcUrl: string, path = "m/44'/60'/0'/0/0"): Promise<User> {
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = HDNodeWallet.fromPhrase(mnemonic, '', path).connect(provider);
    return new User(wallet, provider);
  }

  async getBalance(): Promise<bigint> {
    return this.provider.getBalance(this.address);
  }

  async getNonce(): Promise<number> {
    return this.wallet.getNonce();
  }
}

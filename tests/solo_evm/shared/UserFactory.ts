import { ethers } from 'ethers';
import { User } from './User';

export class UserFactory {
  private rpcUrl: string;
  private funder: User;

  constructor(rpcUrl: string, funder: User) {
    this.rpcUrl = rpcUrl;
    this.funder = funder;
  }

  static async initialize(rpcUrl: string, funderPrivateKey: string): Promise<UserFactory> {
    const funder = await User.fromPrivateKey(funderPrivateKey, rpcUrl);
    return new UserFactory(rpcUrl, funder);
  }

  async createUser(): Promise<User> {
    return User.create(this.rpcUrl);
  }

  async createAndFundUser(amount = ethers.parseEther('10')): Promise<User> {
    const user = await User.create(this.rpcUrl);
    const tx = await this.funder.wallet.sendTransaction({
      to: user.address,
      value: amount,
    });
    await tx.wait();
    return user;
  }

  async createUsers(count: number): Promise<User[]> {
    return Promise.all(
      Array.from({ length: count }, () => User.create(this.rpcUrl))
    );
  }

  async createAndFundUsers(count: number, amount = ethers.parseEther('10')): Promise<User[]> {
    const users = await this.createUsers(count);
    await this.fundUsers(users, amount);
    return users;
  }

  async fundUsers(users: User[], amount = ethers.parseEther('10')): Promise<void> {
    const nonce = await this.funder.getNonce();
    const txs = await Promise.all(
      users.map((user, i) =>
        this.funder.wallet.sendTransaction({
          to: user.address,
          value: amount,
          nonce: nonce + i,
        })
      )
    );
    await Promise.all(txs.map(tx => tx.wait()));
  }

  getFunder(): User {
    return this.funder;
  }
}

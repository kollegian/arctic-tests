import {Contract, ethers} from 'ethers';
//@ts-ignore
import * as abi from "./abi.json"
import testConfig from '../../../config/testConfig.json';

export const evmRpc = testConfig.evmRpcEndpoint;


export async function createProvider() {
  return new ethers.JsonRpcProvider(evmRpc);
}

export function createWalletWithMnemonic(mnemonic: string) {
    return ethers.HDNodeWallet.fromPhrase(mnemonic, '', 'm/44\'/118\'/0\'/0/0');
}

export async function sendERC20(wallet: ethers.HDNodeWallet, tokenAddress: string, toAddress: string, amount: number, provider: ethers.JsonRpcProvider) {
  const connected = wallet.connect(provider);
  const erc20 = new Contract(tokenAddress, abi, connected);
  const transferTx = await erc20.transfer(toAddress, amount);
  const response = await transferTx.wait();
  console.log(response);
  console.log("Transfer successful!");
}

export async function queryEvmBalance(wallet: ethers.HDNodeWallet, provider: ethers.JsonRpcProvider, tokenAddress: string) {
  const connected = wallet.connect(provider);
  const erc20 = new Contract(tokenAddress, abi, connected);
  return erc20.balanceOf(wallet.address);
}

export async function querySupplyOnEvm(wallet: ethers.HDNodeWallet, provider: ethers.JsonRpcProvider, tokenAddress: string) {
  const connected = wallet.connect(provider);
  const erc20 = new Contract(tokenAddress, abi, connected);
  return await erc20.totalSupply();
}
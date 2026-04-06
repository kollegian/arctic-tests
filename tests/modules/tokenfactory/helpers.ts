import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from "@cosmjs/proto-signing";
import * as util from "node:util";
import { seiprotocol } from "@sei-js/proto";
import { evmRpc } from "./evmUtils";
import * as fs from "node:fs";
import { exec as execCallback } from "node:child_process";
import { Buffer } from "buffer";

const exec = util.promisify(execCallback);

import testConfig from '../../../config/testConfig.json';
export const rpcEndpoint: string = testConfig.seiRpcEndpoint;

/**
 * Funds an address with a specified token.
 * @param receiverWallet - The wallet to fund. Can be a DirectSecp256k1HdWallet or a string address.
 * @param token - The token denomination to fund with. Defaults to 'usei'.
 */
export async function fundAddress(receiverWallet: DirectSecp256k1HdWallet | string, token: string = 'usei'): Promise<void> {
  let address: string;
  if (receiverWallet instanceof DirectSecp256k1HdWallet) {
    const [accountData] = await receiverWallet.getAccounts();
    address = accountData.address;
  } else {
    address = receiverWallet;
  }

  let { stdout } = await exec('seid keys show admin --address');
  const senderAddress: string = stdout.trim().replace(/\s+/g, '');
  console.log('Funding sei address');
  ({stdout} = await exec(`seid tx bank send ${senderAddress} ${address} 170000000${token} --from admin --fees 24200usei -y`));
}

/**
 * Retrieves the address from a wallet.
 * @param sender - The wallet from which to retrieve the address.
 * @returns The address as a string.
 */
export async function getAddress(sender: DirectSecp256k1HdWallet): Promise<string> {
  const accounts = await sender.getAccounts();
  return accounts[0].address;
}

/**
 * Waits for a specified number of seconds.
 * @param seconds - Number of seconds to wait.
 */
export async function waitFor(seconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve();
    }, seconds * 1000);
  });
}

/**
 * Generates a valid address from a command.
 * @param walletName - The name of the wallet to generate.
 * @returns An object containing the address and public key.
 */
export async function generateValidAddressFromCommand(walletName: string): Promise<{ address: string; pubkey: string }> {
  console.log('Creating user for ', walletName);
  try {
    await checkKeyExists(walletName);
    await waitFor(1);
    await exec(`seid keys delete ${walletName} -y`);
    await waitFor(0.5);
    const { stdout } = await exec(`seid keys add ${walletName} --output json`);
    const jsonized = JSON.parse(stdout);
    await fundAddress(jsonized.address);
    await waitFor(1);
    return { address: jsonized.address, pubkey: jsonized.pubkey };
  } catch (e) {
    console.log(`Key ${walletName} does not exist on daemon.`);
    const { stdout } = await exec(`seid keys add ${walletName} --output json`);
    const jsonized = JSON.parse(stdout);
    await waitFor(1);
    await fundAddress(jsonized.address);
    return { address: jsonized.address, pubkey: jsonized.pubkey };
  }
}

/**
 * Creates a multisig wallet.
 * @param multisigName - The name of the multisig wallet.
 * @param wallets - An array of wallet names to include in the multisig.
 * @returns An object containing the multisig address and public key.
 */
export async function createMultisig(multisigName: string, wallets: string[]): Promise<{ address: string; pubkey: string }> {
  try {
    await checkKeyExists(multisigName);
    await waitFor(1);
    await exec(`seid keys delete ${multisigName} -y`);
    await waitFor(0.5);
    const creationTx = await exec(`seid keys add ${multisigName} --multisig=${wallets.join(',')} --multisig-threshold 2 --output json`);
    const jsonized = JSON.parse(creationTx.stdout);
    await fundAddress(jsonized.address);
    return { address: jsonized.address, pubkey: jsonized.pubkey };
  } catch (e) {
    const creationTx = await exec(`seid keys add ${multisigName} --multisig=${wallets.join(',')} --multisig-threshold 2 --output json`);
    const jsonized = JSON.parse(creationTx.stdout);
    await fundAddress(jsonized.address);
    return { address: jsonized.address, pubkey: jsonized.pubkey };
  }
}

/**
 * Checks if a key exists.
 * @param keyName - The name of the key to check.
 */
async function checkKeyExists(keyName: string): Promise<void> {
  await exec(`seid keys show ${keyName} --output json`);
}

/**
 * Queries the bank balance of a wallet for a specific denomination.
 * @param wallet - The wallet to query.
 * @param denom - The denomination to query.
 * @returns The balance as a string.
 */
export async function queryBankBalance(wallet: DirectSecp256k1HdWallet, denom: string): Promise<string> {
  const queryClient = await seiprotocol.ClientFactory.createRPCQueryClient({ rpcEndpoint });
  const address = (await wallet.getAccounts())[0].address;
  const balance = await queryClient.cosmos.bank.v1beta1.balance({ address, denom });
  return balance.balance!.amount;
}

/**
 * Generates a valid address and funds it.
 * @returns The generated DirectSecp256k1HdWallet.
 */
export const generateValidAddress = async (): Promise<DirectSecp256k1HdWallet> => {
  const newWallet = await DirectSecp256k1HdWallet.generate(12, { prefix: "sei" });
  const [firstAccount] = await newWallet.getAccounts();
  await fundAddress(firstAccount.address);
  await waitFor(0.5);
  return newWallet;
};

/**
 * Generates multiple valid addresses and funds them.
 * @returns An object containing the generated wallets.
 */
export const generateValidAddresses = async (): Promise<{
  creatorWallet: DirectSecp256k1HdWallet;
  whitelistedWallet: DirectSecp256k1HdWallet;
  unwhitelistedWallet: DirectSecp256k1HdWallet;
  tobeWhitelistedWallet: DirectSecp256k1HdWallet;
  newAdminWallet: DirectSecp256k1HdWallet;
  toBeRemovedUser: DirectSecp256k1HdWallet;
}> => {
  const wallets: DirectSecp256k1HdWallet[] = [];
  for (let i = 0; i < 6; i++) {
    const wallet = await DirectSecp256k1HdWallet.generate(12, { prefix: "sei" });
    const [{ address }] = await wallet.getAccounts();
    await fundAddress(address);
    await waitFor(2);
    wallets.push(wallet);
  }
  const [creatorWallet, whitelistedWallet, unwhitelistedWallet, tobeWhitelistedWallet, newAdminWallet, toBeRemovedUser] = wallets;
  return {
    creatorWallet,
    whitelistedWallet,
    unwhitelistedWallet,
    tobeWhitelistedWallet,
    newAdminWallet,
    toBeRemovedUser,
  };
};

/**
 * Retrieves the query client.
 * @returns The RPC query client.
 */
export async function getQueryClient(): Promise<ReturnType<typeof seiprotocol.ClientFactory.createRPCQueryClient>> {
  return await seiprotocol.ClientFactory.createRPCQueryClient({ rpcEndpoint });
}

/**
 * Generates a valid address without funding it.
 * @returns The generated address as a string.
 */
export async function generateValidAddressWithoutFunds(): Promise<string> {
  const newWallet = await DirectSecp256k1HdWallet.generate(12, { prefix: "sei" });
  const [firstAccount] = await newWallet.getAccounts();
  return firstAccount.address;
}

/**
 * Deploys a pointer with the specified denomination.
 * @param fullDenom - The full denomination to register.
 */
export async function deployPointer(fullDenom: string): Promise<void> {
  await exec(`seid tx evm register-evm-pointer NATIVE ${fullDenom} --from=admin --fees 24000usei --evm-rpc=${evmRpc}`);
}

/**
 * Queries the pointer address for a specific denomination.
 * @param fullDenom - The full denomination to query.
 * @returns The pointer address.
 */
export async function queryPointerAddress(fullDenom: string): Promise<any> { // Replace `any` with the actual response type
  const seiq = await seiprotocol.ClientFactory.createRPCQueryClient({ rpcEndpoint });
  return await seiq.seiprotocol.seichain.evm.pointer({ pointerType: 2, pointee: fullDenom });
}

/**
 * Executes a command and returns its JSON output.
 * @param command - The command to execute.
 * @returns The parsed JSON output.
 */
export async function execCommandAndReturnJson(command: string): Promise<any> { // Replace `any` with the actual expected type
  const { stdout } = await exec(`${command} --output json`);
  await waitFor(0.8);
  return JSON.parse(stdout);
}

/**
 * Decodes a base64-encoded key.
 * @param base64Key - The base64-encoded key.
 * @returns The decoded key as a Buffer.
 */
export function decodeBase64Key(base64Key: string): Buffer {
  return Buffer.from(base64Key, "base64");
}

/**
 * Hashes a key using SHA-256.
 * @param key - The key to hash.
 * @returns The hashed key as a hexadecimal string.
 */
export function hashKey(key: string | Buffer): string {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Generates token metadata and writes it to a JSON file.
 * @param fullDenom - The full denomination of the token.
 */
export function generateTokenMetadata(fullDenom: string): string {
  const metadata = {
    name: fullDenom,
    description: "A token created using the Token Factory module.",
    symbol: fullDenom,
    denom_units: [
      {
        denom: fullDenom,
        exponent: 0,
        aliases: ["microdenom"]
      },
      {
        denom: "mtest1",
        exponent: 6
      },
      {
        denom: "test1",
        exponent: 12
      }
    ],
    base: fullDenom,
    display: "test1"
  };
  fs.writeFileSync('token_metadata.json', JSON.stringify(metadata, null, 2));
  console.log('Token metadata written to the folder');
  return 'token_metadata.json'
}

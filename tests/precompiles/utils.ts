import util from "node:util";
import {Tendermint34Client} from "@cosmjs/tendermint-rpc";
import {QueryClient, setupBankExtension} from "@cosmjs/stargate";
import {Contract, ethers} from "ethers";
import {SeiUser} from '../../shared/User';
import fs from 'fs';
const exec = util.promisify(require('node:child_process').exec);
import testConfig from "../../config/testConfig.json";
import {
  BANK_PRECOMPILE_ADDRESS,
  DIST_PRECOMPILE_ADDRESS,
  GOV_PRECOMPILE_ADDRESS,
  STAKING_PRECOMPILE_ADDRESS
} from './constants';
import BANK_ABI from './abis/bank_abi.json';
import DISTR_ABI from './abis/distr_abi.json';
import GOV_ABI from './abis/gov_abi.json';
import STAKING_ABI from './abis/staking_abi.json';
import {execCommandAndReturnJson} from '../../utils/cliUtils';

export async function mintTokens(minter: SeiUser, denom: string, amount: string){
  return await execCommandAndReturnJson(`seid tx tokenfactory mint ${amount}${denom} --from ${minter.seiAddress} --fees 24200usei -y --broadcast-mode block`);
}

export async function setMetadataOfaToken(fullDenom: string, admin: SeiUser){
  const metadataFile = generateTokenMetadata(fullDenom);
  await execCommandAndReturnJson(`seid tx tokenfactory set-denom-metadata ${metadataFile} --from ${admin.seiAddress} --fees 24200usei -y --broadcast-mode block`);
}

export async function returnQueryClient(extensionSetup: any){
  const cometClient = await Tendermint34Client.connect(testConfig.seiRpcEndpoint);
  return QueryClient.withExtensions(cometClient, extensionSetup);
}


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


export async function queryCwBalance(owner: SeiUser, cw1155ContractAddress: string, tokenId: string, wasmdContract: Contract){
  const query = {
    balance_of: {
      owner: owner.seiAddress,
      token_id: tokenId,
    },
  };
  const req = ethers.toUtf8Bytes(JSON.stringify(query));
  const responseBytes = await wasmdContract.query(cw1155ContractAddress, req);
  const preBalance = JSON.parse(ethers.toUtf8String(responseBytes));
  return Number(preBalance.balance);
}

export async function returnContracts(owner: SeiUser){
  const bankContract = new ethers.Contract(BANK_PRECOMPILE_ADDRESS, BANK_ABI, owner.evmWallet.wallet);
  const govContract = new ethers.Contract(GOV_PRECOMPILE_ADDRESS, GOV_ABI, owner.evmWallet.wallet);
  const stakingContract = new ethers.Contract(STAKING_PRECOMPILE_ADDRESS, STAKING_ABI, owner.evmWallet.wallet);
  const distrContract = new ethers.Contract(DIST_PRECOMPILE_ADDRESS, DISTR_ABI, owner.evmWallet.wallet);
  return {bankContract, govContract, stakingContract, distrContract};
}
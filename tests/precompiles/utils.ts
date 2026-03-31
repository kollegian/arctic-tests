import util from "node:util";
import {Tendermint34Client} from "@cosmjs/tendermint-rpc";
import {QueryClient, setupBankExtension, setupStakingExtension, StakingExtension} from "@cosmjs/stargate";
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
import {execCommandAndReturnJson} from "../../shared/utils/cliUtils";
import {parseEther} from "ethers";

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

export function findValidator(validators: any, operatorPubkey: string){
   return validators.validators.find(validator => {
        const buf = Buffer.from(validator.consensusPubkey!.value, 'base64');
        const pubkey = buf.slice(2);
        return pubkey.toString('hex') === operatorPubkey;
    });
}

export async function getProposalID(govContract: Contract, proposalJSON: any){
    const proposalId: bigint = await govContract
        .submitProposal
        .staticCall(proposalJSON, { value: parseEther("10") });
    return Number(proposalId);
}

export async function queryAllStakes(user: SeiUser){
    const stakingQueryClient = await returnQueryClient(setupStakingExtension) as QueryClient & StakingExtension;
    const delegations = await stakingQueryClient.staking.delegatorDelegations(user.seiAddress);
    console.log(delegations);
    const totalStake = delegations.delegationResponses.reduce((total, resp) => {
        return total += Number(resp.balance.amount);
    }, 0);
    console.log(totalStake);
    return totalStake;
}
export function returnTextProposal(isExpedited = false, title="Test Text Proposal") {
    return JSON.stringify({
        "title": title,
        "description": "This is a test text proposal for governance",
        "type": "Text",
        "is_expedited": isExpedited
    })
}

export function parseRewardsResponse(rewards: any) {
    return {
        rewards: rewards.rewards.map((r: any) => ({
            coins: r.coins.map((c: any) => ({
                amount: c.amount.toString(),
                decimals: Number(c.decimals),
                denom: c.denom
            })),
            validator_address: r.validator_address
        })),
        total: rewards.total.map((t: any) => ({
            amount: t.amount.toString(),
            decimals: Number(t.decimals),
            denom: t.denom
        }))
    };
}

export function calculateTotalRewardsAmount(parsedRewards: { total: Array<{ amount: string; decimals: number; denom: string }> }): bigint {
    let total = BigInt(0);
    for (const coin of parsedRewards.total) {
        if (coin.denom === 'usei') {
            total += BigInt(coin.amount);
        }
    }
    return total;
}

export function findEvent(receipt: any, contract: any, eventName: string) {
    return receipt.logs.find((l: any) => {
        try { return contract.interface.parseLog(l)?.name === eventName; }
        catch { return false; }
    });
}

export async function waitForRewards(distrContract: any, delegatorAddress: string, maxWaitSeconds = 120): Promise<bigint> {
    const pollInterval = 5;
    let elapsed = 0;
    const { waitFor } = await import('../../shared/utils/helpers');
    while (elapsed < maxWaitSeconds) {
        const rewards = await distrContract.rewards(delegatorAddress);
        const parsed = parseRewardsResponse(rewards);
        const total = calculateTotalRewardsAmount(parsed);
        if (total > BigInt(0)) return total;
        await waitFor(pollInterval);
        elapsed += pollInterval;
    }
    throw new Error(`No rewards accumulated after ${maxWaitSeconds}s`);
}

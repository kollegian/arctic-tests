import util from "node:util";
import {exec as execCallback} from "node:child_process";
import {waitFor} from "./helpers";
import {SeiUser} from "../shared/User";
const exec = util.promisify(execCallback);
import abi from "../utils/abis/ct_abi.json";
export async function execCommandAndReturnJson(command: string): Promise<any> {
    const { stdout } = await exec(`${command} --output json`);
    await waitFor(0.8);
    return JSON.parse(stdout);
}

export async function createTokenfactoryDenom(sender: SeiUser, secondUser: SeiUser){
    const allowListFile = "allowlist.json";
    await exec(`echo '{"addresses": ["${sender.seiAddress}", "${secondUser.seiAddress}"]}' > ${allowListFile}`);
    await waitFor(1);
    await execCommandAndReturnJson(`seid tx tokenfactory create-denom test --from ${sender.seiAddress} --fees 24200usei --allow-list ${allowListFile} --broadcast-mode block -y`);
    return `factory/${sender.seiAddress}/test`;
}

export async function getDecryptedBalance(user: SeiUser, tokenName = 'usei'){
    const rawOutput = await exec(`seid q ct account ${tokenName} ${user.seiAddress} --decrypt-available-balance --decryptor ${user.seiAddress} --output json`);
    const onlyData = rawOutput.stdout.slice(rawOutput.stdout.indexOf('{')).trim();
    return JSON.parse(onlyData);
}

export async function getCryptedBalance(user: SeiUser, tokenName = 'usei'){
    const rawOutput = await exec(`seid q ct account ${tokenName} ${user.seiAddress} --output json`);
    return JSON.parse(rawOutput.stdout);
}

export function getPayload(){
    return {
        'initializeAccount': async (sender: SeiUser, denom = 'usei') => await exec(`seid q evm ct-init-account-payload ./utils/abis/ct_abi.json ${sender.seiAddress} ${denom}`),
        'applyPendingBalances': async (sender: SeiUser, denom = 'usei') => await exec(`seid q evm ct-apply-pending-balance-payload ./utils/abis/ct_abi.json ${sender.seiAddress} ${denom}`),
        'transfer': async (sender: SeiUser, receiver: SeiUser, denom = 'usei', amount: string) => await exec(`seid q evm ct-transfer-payload ./utils/abis/ct_abi.json ${sender.seiAddress} ${receiver.seiAddress} ${amount}${denom}`),
        'withdrawFunds': async (sender: SeiUser, amount: string, denom = 'usei') => await exec(`seid q evm ct-withdraw-payload ./utils/abis/ct_abi.json ${sender.seiAddress} ${amount}${denom}`),
        'closeAccount': async (sender: SeiUser, denom = 'usei') => await exec(`seid q evm ct-close-account-payload ./utils/abis/ct_abi.json ${sender.seiAddress} ${denom}`),
        'deposit': async (denom: string, depositAmount: string) => await exec(`seid q evm payload ./utils/abis/ct_abi.json deposit ${denom} ${depositAmount}`)
    }
}
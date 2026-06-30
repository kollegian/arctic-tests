import { SeiUser } from "../../shared/User";

/** Latest CosmWasm contract address instantiated under a given code id. */
export async function getLatestContractForCode(admin: SeiUser, cId: number): Promise<string> {
    const contracts = await admin.seiWallet.cosmWasmSigningClient.getContracts(cId);
    return contracts[contracts.length - 1];
}

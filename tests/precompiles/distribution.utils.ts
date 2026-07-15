import { execCommandAndReturnJson } from "../../shared/utils/cliUtils";
import { moduleAddress } from "./utils";

/**
 * Resolve a genuine, blocklisted ModuleAccount by name. The address is derived
 * locally (sha256(name)[:20]) and confirmed against the auth store, instead of
 * paging `seid q auth accounts`: on a live chain with more than one page of
 * accounts the module accounts are not guaranteed to be in the first page.
 */
export async function findModuleAccount(preferred: string): Promise<{ name: string; address: string }> {
    const address = moduleAddress(preferred);
    const account = await execCommandAndReturnJson(`seid q auth account ${address}`);
    if (account["@type"] !== "/cosmos.auth.v1beta1.ModuleAccount") {
        throw new Error(`account ${address} ("${preferred}") is not a ModuleAccount: ${account["@type"]}`);
    }
    return { name: account.name, address: account.base_account.address };
}

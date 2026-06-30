import { execCommandAndReturnJson } from "../../shared/utils/cliUtils";

/** Discover a genuine, blocklisted ModuleAccount address from the auth store. */
export async function findModuleAccount(preferred: string): Promise<{ name: string; address: string }> {
    const res = await execCommandAndReturnJson("seid q auth accounts --limit 1000 --output json");
    const accounts: any[] = res.accounts ?? [];
    const modules = accounts.filter((a) => a["@type"] === "/cosmos.auth.v1beta1.ModuleAccount");
    const pick = modules.find((m) => m.name === preferred) ?? modules[0];
    return { name: pick.name, address: pick.base_account.address };
}

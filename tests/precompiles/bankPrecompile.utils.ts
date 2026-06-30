import { ethers } from "ethers";
import { expect } from "chai";
import { SeiUser } from "../../shared/User";
import { execCommandAndReturnJson } from "../../shared/utils/cliUtils";
import { waitFor } from "../../shared/utils/helpers";

export const USEI_PER_WEI = 10n ** 12n; // 1 usei == 1e12 wei on the Sei EVM
export const SEI = 1_000_000n;          // 1 SEI == 1_000_000 usei
export const toWei = (usei: bigint) => usei * USEI_PER_WEI;

export interface ModuleAccountInfo {
    name: string;
    address: string;
    permissions: string[];
}

/** Discover the chain's genuine ModuleAccounts (typed as ModuleAccount in the auth store). */
export async function listModuleAccounts(): Promise<ModuleAccountInfo[]> {
    const res = await execCommandAndReturnJson('seid q auth accounts --limit 1000 --output json');
    const accounts: any[] = res.accounts ?? [];
    return accounts
        .filter((a) => a['@type'] === '/cosmos.auth.v1beta1.ModuleAccount')
        .map((a) => ({
            name: a.name,
            address: a.base_account?.address,
            permissions: a.permissions ?? [],
        }));
}

/**
 * eth_getBalance on this endpoint returns a fixed "balance floor" for EVERY address
 * — even never-used ones — and that floor materialises into real spendable funds the
 * first time the account lands a successful EVM tx. We read it dynamically from a
 * fresh random address so the assertions hold both here (floor > 0) and on a clean
 * node (floor 0).
 */
export async function evmFloorUsei(admin: SeiUser): Promise<bigint> {
    const provider = admin.evmWallet.wallet.provider!;
    const wei = await provider.getBalance(ethers.Wallet.createRandom().address);
    return wei / USEI_PER_WEI;
}

export async function evmSpendableUsei(admin: SeiUser, evmAddress: string): Promise<bigint> {
    const provider = admin.evmWallet.wallet.provider!;
    return (await provider.getBalance(evmAddress)) / USEI_PER_WEI;
}

/**
 * Attempt a sendNative. Returns ok=true only on a successful (status 1) receipt.
 * A submission rejection (e.g. "insufficient funds") or a tx that never mines (a
 * vesting account with no real spendable can get wedged in the mempool) both count
 * as ok=false, with the underlying reason captured for the assertion message.
 */
export async function trySendNative(
    admin: SeiUser,
    bankContract: ethers.Contract,
    user: SeiUser,
    toSei: string,
    valueUsei: bigint,
    timeoutMs = 30000
): Promise<{ ok: boolean; reason: string }> {
    const provider = admin.evmWallet.wallet.provider!;
    const c = bankContract.connect(user.evmWallet.wallet) as ethers.Contract;
    try {
        const tx = await c.sendNative(toSei, { value: toWei(valueUsei), gasLimit: 400000 });
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const r = await provider.getTransactionReceipt(tx.hash).catch(() => null);
            if (r) return { ok: r.status === 1, reason: `mined status=${r.status}` };
            await waitFor(2);
        }
        return { ok: false, reason: 'not mined within timeout (wedged in mempool)' };
    } catch (e: any) {
        const reason = e?.info ? JSON.stringify(e.info) : e?.shortMessage ?? e?.message ?? String(e);
        return { ok: false, reason };
    }
}

export async function createVesting(user: SeiUser, lockedUsei: bigint) {
    const endTime = Math.floor(Date.now() / 1000) + 3600; // 1h cliff
    const out = await execCommandAndReturnJson(
        `seid tx vesting create-vesting-account ${user.seiAddress} ${lockedUsei}usei ${endTime} ` +
        `--delayed --from admin --fees 24500usei -y --broadcast-mode block --output json`
    );
    expect(out.code, `create-vesting-account failed: ${out.raw_log}`).to.equal(0);
    await waitFor(2);
}

/** MsgAssociate is feeless on Sei, so even a 0-spendable (fully locked) account can associate. */
export async function associateFeeless(user: SeiUser) {
    user.seiWallet.updateFee({ amount: [], gas: '200000' });
    const assoc = await user.seiWallet.associate();
    expect(assoc.code, `associate failed: ${assoc.rawLog}`).to.equal(0);
    await waitFor(2);
    const evmAddr = await execCommandAndReturnJson(`seid q evm evm-addr ${user.seiAddress}`);
    expect(evmAddr.associated, `user ${user.seiAddress} should be associated`).to.equal(true);
}

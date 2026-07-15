import { SeiUser } from '../../shared/User';
import { Cw20Token } from '../../shared/Token';
import { existingWasmAddresses } from '../../shared/utils/testFlags';
import { waitFor } from '../../shared/utils/helpers';

/**
 * The chain tests never store/instantiate wasm code themselves (uploads are
 * slow and expensive on live networks). They run against contracts that
 * already exist on the target network, resolved via testConfig.existingWasm
 * or knownContractAddresses.json. Callers must skip when an address is
 * undefined for the current network.
 */
export { existingWasmAddresses };

export function buildWasmExecuteMsg(sender: string, contract: string, wasmMsg: object) {
    return {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: {
            sender,
            contract,
            msg: Buffer.from(JSON.stringify(wasmMsg)),
            funds: [],
        },
    };
}

/**
 * Ensure `user` holds at least `minBalance` of the existing CW20. The admin is
 * the contract's minter, so a top-up is a plain execute (no deployment).
 * Returns the Cw20Token bound to the admin signer.
 */
export async function ensureCw20Balance(
    admin: SeiUser,
    cw20Address: string,
    user: SeiUser,
    minBalance: bigint,
): Promise<Cw20Token> {
    const cw20 = new Cw20Token(admin, cw20Address);
    const balance = BigInt(await cw20.balanceOf(user.seiAddress));
    if (balance < minBalance) {
        await cw20.mint(user.seiAddress, (minBalance - balance).toString());
        await waitFor(1);
    }
    return cw20;
}

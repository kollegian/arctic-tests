import {SeiUser} from "../../../../shared/User";
import {Erc20Token} from "../../../../shared/Token";
import {Interface} from "ethers";

export async function approveAndMint(contract: Erc20Token, testUser: SeiUser, vaultAddress: string, depositAmount: string){
    const mintTx = await contract.mint(testUser.evmAddress, depositAmount);
    await mintTx.wait();

    const approvalTx = await contract.approve(vaultAddress, depositAmount);
    await approvalTx.wait();
}

export function decodeRevert(revertData: unknown, abi: any[]): string | undefined {
    try {
        if (!revertData) return undefined;
        const dataHex = typeof revertData === 'string' ? revertData : (revertData as any).data;
        if (typeof dataHex !== 'string' || !dataHex.startsWith('0x')) return undefined;
        const iface = new Interface(abi as any);
        const parsed = iface.parseError(dataHex);
        if (!parsed) return undefined;
        const args = parsed.args?.map((a: any) => (typeof a === 'bigint' ? a.toString() : a));
        return `${parsed.name}(${args?.join(', ') ?? ''})`;
    } catch (_) {
        return undefined;
    }
}

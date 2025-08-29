import {EvmRpcClient} from "../../shared/RpcClient";
import {ethers} from "ethers";

export async function getBaseFeePerBlock(txHash: string, rpcClient: EvmRpcClient) {
    const contrReceipt = await rpcClient.getTransactionReceipt(txHash);
    const block = await rpcClient.getBlockByNumber(ethers.toQuantity(contrReceipt!.blockNumber), true);
    return block.baseFeePerGas;

}

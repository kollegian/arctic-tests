import { ethers } from "ethers";
import { NonceManager } from "./NonceManager";
import { SequenceManager } from "./sequenceManager";
import { Cw20Token, Erc20Token } from "../../shared/Token";
import { SeiUser } from "../../shared/User";
import {AtomicTxSender} from "../../shared/TxBuilder";

export class TxFormer {
    static async broadcastEvmTx(
        erc20    : Erc20Token,
        sender   : SeiUser,
        receiver : SeiUser,
        amount   : bigint,
        provider: ethers.JsonRpcProvider,
        nonceMgr : NonceManager
    ): Promise<string> {
        const data = erc20.contract.interface.encodeFunctionData(
            "transfer", [receiver.evmAddress, amount]
        );
        const signed = await AtomicTxSender.signEvmTransaction(
            sender, erc20.getAddress(), data, false, nonceMgr
        );
        return AtomicTxSender.sendRawTransactionWithProvider(provider, signed);
    }

    static async signCosmosTransfer(
        sender   : SeiUser,
        receiver : SeiUser,
        cw20     : Cw20Token,
        seqMgr   : SequenceManager
    ) {
        const raw  = cw20.returnEncodedTransfer(sender, receiver.seiAddress, "100000");
        const { accountNumber, sequence } = await seqMgr.take(sender.seiAddress);
        const chainId = await sender.seiWallet.signingClient.getChainId();
        const signerData = { accountNumber, sequence, chainId } as const;
        return cw20.sign(sender, raw, signerData);
    }
}

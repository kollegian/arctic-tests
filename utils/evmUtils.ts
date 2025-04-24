import {SeiUser} from "../shared/User";

export async function broadcastTx(sender: SeiUser, payload: any, contractAddress: string){
    const nonce = await sender.evmWallet.wallet.getNonce();
    const gasPrice = await sender.evmWallet.signingClient.getFeeData();
    const tx = {
        nonce: nonce,
        gasPrice: gasPrice.gasPrice,
        gasLimit: "5000000",
        to: contractAddress,
        value:"0",
        data: '0x'+payload,
        chainId: 713715,
    };

    const signedTx = await sender.evmWallet.wallet.signTransaction(tx);
    const txResponse = await sender.evmWallet.signingClient.broadcastTransaction(signedTx);
    return await txResponse.wait();
}

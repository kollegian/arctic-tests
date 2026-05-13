import {SeiUser} from "./User";
import {Cw20Token, Cw721Token, Erc20Token, Erc721Token} from "./Token";
import {ethers} from "ethers";
import {AtomicTxSender} from "./TxBuilder";
import {EvmRpcClient} from "./RpcClient";
import {waitFor} from "./utils/helpers";

export default class TransactionBuilder {
    // it should be able to create txs for cw721, cw20, erc20, erc721
    // should read from users
    private users: SeiUser[] = [];
    private cw20Token!: Cw20Token;
    private cw721Token!: Cw721Token;
    private erc20Token!: Erc20Token;
    private erc721Token!: Erc721Token;
    private evmRpcClient: EvmRpcClient;

    constructor(users: SeiUser[]){
        this.users = users;
        this.evmRpcClient = new EvmRpcClient(users[0].evmRpcEndpoint, users[0].evmWallet.signingClient);
    }

    setCw20Token(cw20Token: Cw20Token){
        this.cw20Token = cw20Token;
    }

    setCw721Token(cw721Token: Cw721Token){
        this.cw721Token = cw721Token;
    }

    setErc20Token(erc20Token: Erc20Token){
        this.erc20Token = erc20Token;
    }

    setErc721Token(erc721Token: Erc721Token){
        this.erc721Token = erc721Token;
    }

    async formErc20TransferTxs(){
        const encodedTx = this.erc20Token.contract.interface.encodeFunctionData("transfer", [this.users[0].evmAddress, '10000']);
        const signedTxs = await Promise.all(this.users.map(async (user) => {
            return await AtomicTxSender.signEvmTransaction(user, this.erc20Token.getAddress(), encodedTx);
        }));
        for (const user of this.users) {
            const index1 = this.users.indexOf(user);
            AtomicTxSender.sendRawTransaction(user.evmRpcEndpoint, signedTxs[index1], user);
            this.cw20Token.setSigner(user);
            const txData = this.cw20Token.transfer(this.users[0].seiAddress, '1000');
            await waitFor(0.04);
        }
        await waitFor(1);
        return this.findCombinedBlockTx();
    }

    async formToken721Txs(){
        const encodedTxs = this.users.map((user, index) => {return this.erc721Token.contract.interface.encodeFunctionData("approve", [this.users[0].evmAddress, index.toString()])});
        const signedTxs = await Promise.all(this.users.map(async (user, index) => {
            return await AtomicTxSender.signEvmTransaction(user, this.erc721Token.getAddress(), encodedTxs[index]);
        }));
        for (const user of this.users) {
            const index1 = this.users.indexOf(user);
            AtomicTxSender.sendRawTransaction(user.evmRpcEndpoint, signedTxs[index1], user);
            this.cw721Token.setSigner(user);
            this.cw721Token.safeTransferFrom(user.seiAddress, this.users[0].seiAddress, index1.toString());
            await waitFor(0.04);
        }
        await waitFor(4);
        return this.findCombinedBlockTx();
    };

    async formErc721TransferTxs(){

    }

    async formEvmFailingTxsForErc20(){

    };

    async formMultipleEventTxsForCw20() {

    };

    async formMultipleEventTxsForCw721() {

    };

    async findCombinedBlockTx() {
        let blockNumber = await this.evmRpcClient.getBlockNumber();
        let seiTxs = await this.evmRpcClient.sei_getBlockByNumber(ethers.toQuantity(blockNumber), true);
        let evmTxs = await this.evmRpcClient.getBlockByNumber(ethers.toQuantity(blockNumber), true);
        let index = 0;
        while(seiTxs.transactions.length === evmTxs.transactions.length || (seiTxs.transactions.length === 0 || evmTxs.transactions.length === 0)){
            blockNumber--;
            seiTxs = await this.evmRpcClient.sei_getBlockByNumber(ethers.toQuantity(blockNumber), true);
            evmTxs = await this.evmRpcClient.getBlockByNumber(ethers.toQuantity(blockNumber), true);
            if (index === 150){
                throw new Error('Reached end of block chain');
            }
            index++;
        }
        return blockNumber;
    }
}

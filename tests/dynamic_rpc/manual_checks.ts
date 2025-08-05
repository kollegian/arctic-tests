import {UserFactory} from "../../shared/User";
import {EvmRpcClient} from "../../shared/RpcClient";

const main = async () =>{
    const admin = await UserFactory.createAdminUser();
    const rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
    const blockNum = '0xab0a3e6';
    const block = await rpcClient.getBlockByNumber(blockNum, true);
    console.log(block);
    console.log('******');
    const receipts = await rpcClient.getBlockReceipts(blockNum);
    const printedLogs = receipts.map(r => console.log(r.logs));

    const logs = {
        fromBlock: blockNum,
        toBlock: blockNum,
    }
    const queriedLogs = await rpcClient.getLogs(logs);
    console.log('*********');
    console.log(queriedLogs);
}

main();

import heavyGasAbi from "../../artifacts/contracts/GasBurner.sol/RealGasBurner.json";
import {UserFactory } from "../../shared/User";
import {ethers} from "ethers";
import {SeiUser} from "../../shared/User";
import {EvmRpcClient} from "../../shared/RpcClient";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {waitFor} from "../../shared/utils/helpers";
import * as ercAbi from "../../artifacts/contracts/TestERC20.sol/TestERC20.json";
import {myErc} from "../indexers/atlantic-2-usdc/generated/myErc/myErc";
import {TestERC20} from "../../typechain-types";
import {TokenDeployer} from "../../shared/Deployer";

const main = async () => {
    const admin = await UserFactory.createAdminUser();
    const gasContract = new ethers.Contract("0x81EA6423D30fC55d76A5Fa67fADee5905c2692B0", heavyGasAbi.abi, admin.evmWallet.wallet);
    const data = gasContract.interface.encodeFunctionData(
        "burnGasOverMaxLimit",
        [1001]
    );
    const chainId = (await admin.evmWallet.signingClient.getNetwork()).chainId
    const txRequest = {
        to: gasContract.target,
        data: data,
        value: 0n,
        gasLimit: 8000000n,
        maxFeePerGas: 3550000000n,
        maxPriorityFeePerGas: 3000000000n,
        nonce: await admin.evmWallet.wallet.getNonce('latest'),
        chainId: chainId,
        type: 2
    };
    const signedTx = await admin.evmWallet.wallet.signTransaction(txRequest);
    const txHash = await admin.evmWallet.signingClient.broadcastTransaction(signedTx);
    console.log(txHash);
    await waitFor(0.5);
    const fee_history = await admin.evmWallet.signingClient.send('eth_feeHistory', ["0x4",
        "latest",
        [25, 100]]);
    console.log(fee_history);
}

const bombChainWithTxs = async() => {
    // continously send txs on evm side,
    // continously send txs on cosmos side,
    // check the number of txs on evm and sei side and get the block that is different
    const admin = await UserFactory.createAdminUser();
    const rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
    const erc20 = new Erc20Token(admin, '0x6Bf11fd59CAFd55D78FC7Be6037Ddf22D41b6CF6');
    const users = await UserFactory.createSeiUsers(admin, 10, true);
    const cw20 = new Cw20Token(admin, 'sei1vh2p4x96m0qcvhzh3g86dxg9zu8pzwj4xuuwyf2z8dpmshcf0qms40dud3');
    let index = 0;
    const encodedData = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('0.01')]);
    const signedTxs = await Promise.all(users.map(async (user) => {
       return await AtomicTxSender.signEvmTransaction(user, erc20.getAddress(), encodedData);
    }))
    while (index < 30){
        index++;
        AtomicTxSender.sendRawTransaction(users[0].evmRpcEndpoint, signedTxs[index], admin);
        cw20.setSigner(users[index]);
        cw20.transfer(admin.seiAddress, '1000');
    }

    // retrospectively query the tx length
    console.log('Sent all txs');
    await waitFor(5);
    let currentBlock = await rpcClient.getBlockNumber();
    let ethTxLength = await rpcClient.getBlockByNumber(ethers.toQuantity(currentBlock), false);
    let seiTxLength = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(currentBlock), true);
    let retries = 0;
    while(retries <100) {
        if (ethTxLength.transactions.length !== seiTxLength.transactions.length) {
            if (ethTxLength.transactions.length > 0 && seiTxLength.transactions.length > 0) {
                console.log('Found block number is ', currentBlock);
                console.log('eth tx length is ', ethTxLength.transactions.length);
                console.log('sei tx length is ', seiTxLength.transactions.length);
                console.log('Found');
                break;
            }
        }
        ethTxLength = await rpcClient.getBlockByNumber(ethers.toQuantity(currentBlock -1), false);
        seiTxLength = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(currentBlock -1), true);
        retries++;
        currentBlock--;
        console.log('Checking block number is ', currentBlock);
        console.log('eth tx length is ', ethTxLength.transactions.length);
        console.log('sei tx length is ', seiTxLength.transactions.length);
    }
}

const checkGasPaid = async () => {
    const admin = await UserFactory.createAdminUser();
    const rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
    const erc20 = new Erc20Token(admin, '0x6Bf11fd59CAFd55D78FC7Be6037Ddf22D41b6CF6');
    const cw20 = new Cw20Token(admin, 'sei1vh2p4x96m0qcvhzh3g86dxg9zu8pzwj4xuuwyf2z8dpmshcf0qms40dud3');
    const users = await UserFactory.createSeiUsers(admin, 10, true);

    let index = 1;
    while (index < 30){
        index++;
        cw20.setSigner(users[index]);
        cw20.transfer(admin.seiAddress, '1000');
    }

    const encodedData = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('0.01')]);
    const balance = await users[0].evmWallet.queryBalance();
    const signedTx = await AtomicTxSender.signEvmTransaction(users[0], erc20.getAddress(), encodedData);
    const hash = await AtomicTxSender.sendRawTransaction(users[0].evmRpcEndpoint, signedTx, admin);
    await waitFor(1);
    const afterBalance = await users[0].evmWallet.queryBalance();
    const txReceipt = await rpcClient.getTransactionReceipt(hash);
    const actualGasPaid = txReceipt.gasUsed * txReceipt.effectiveGasPrice;
    console.log(Number(txReceipt.effectiveGasPrice));
    console.log(Number(actualGasPaid));

    console.log(Number(afterBalance - balance));
    const block = await rpcClient.getBlockByNumber(ethers.toQuantity(txReceipt.blockNumber), true);
    console.log(block);
}

const checkBlockRpc = async () => {
    console.log('Starting');
    const evmRpcEndpoint = 'https://black-dark-breeze.sei-pacific.quiknode.pro';
    const provider = new ethers.JsonRpcProvider(evmRpcEndpoint);
    const rpcClient = new EvmRpcClient(evmRpcEndpoint, provider);
    const block = await rpcClient.getBlockByHash('0xe92b3014de653a06c7702421fa61d4cececbbca3d01517cfa8d77bfd42c62c67', true);
    console.log(block);
    console.log('******');
    const receipts = await rpcClient.getBlockReceipts(ethers.toQuantity(155104996));
    console.log('*******');
    const printedLogs = receipts.map(r => console.log(r));
}

const getSignedTx = async () => {
    const rpc = 'https://evm-rpc.sei-apis.com';
    const seiRpc = 'https://rpc.sei-apis.com';

    const admin = await UserFactory.createAdminUser();
    console.log(admin.evmWallet.wallet.privateKey);
    /*console.log(await admin.evmWallet.queryBalance());

    const erc20Contr = new ethers.Contract('0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1', ercAbi.abi, admin.evmWallet.wallet) as unknown as TestERC20;
    const approveTx = erc20Contr.interface.encodeFunctionData('approve', ['0x92D54824d32221FF3aC12B8cEA62D3de3ac332B9', ethers.parseEther('5.1')]);
    const encodedTx = await AtomicTxSender.signEvmTransaction(admin, await erc20Contr.getAddress(), approveTx, '1500000000', '3900000000');
    const txHash = await AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, encodedTx, admin);
    console.log(txHash);
    console.log('Admin address is ', admin.evmAddress);
    console.log(admin.evmWallet.wallet.privateKey);*/
}

const deployErc20 = async () => {
    const admin = await UserFactory.createAdminUser();
    const tokenDeployer = new TokenDeployer(admin);
    const erc20 = await tokenDeployer.deployErc20();
    await erc20.mint(admin.evmAddress, ethers.parseEther('1000'));
}

main();

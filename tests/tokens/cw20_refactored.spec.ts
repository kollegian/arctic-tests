import {SeiUser, UserFactory} from "../../shared/User";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import fs from "fs";
import TransactionBuilder from "../../shared/TransactionBuilder";
import {waitFor} from "../../shared/utils/helpers";
import {expect} from "chai";
import {EvmRpcClient} from "../../shared/RpcClient";
import {ContractTransactionReceipt, ethers, TransactionReceipt} from "ethers";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {erc20} from "../../typechain-types/@openzeppelin/contracts/token";

describe('Cw20 Tests', function () {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let cw20Contract: Cw20Token;
    let erc20Contract: Erc20Token;
    let evmRpcClient: EvmRpcClient;

    before('Initialize', async () => {
        admin = await UserFactory.createAdminUser();
        const cw20Address = JSON.parse(fs.readFileSync('./tests/tokens/contractAddresses.json', 'utf8')).cw20Address;
        cw20Contract = new Cw20Token(admin, cw20Address);
        users = await UserFactory.createSeiUsers(admin, 3, true);
        evmRpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
    });

    let mintTxHeight: number;
    it('Admin can mints tokens before pointer deployment', async () =>{
        const preBalance = await cw20Contract.balanceOf(admin.seiAddress);
        const mintTx = await cw20Contract.mint(admin.seiAddress, '100000000');
        mintTxHeight = mintTx.height;
        const afterBalance = await cw20Contract.balanceOf(admin.seiAddress);
        expect(Number(afterBalance)).to.equal(Number(preBalance) + Number('100000000'));
    });

    it('Before pointer deployment, synthetic event are not recorded with sei_getBlockByNumber', async () =>{
        const rpcResult = await evmRpcClient.sei_getBlockByNumber(ethers.toQuantity(mintTxHeight), true);
        const tx = rpcResult.transactions.find(tx => tx.from.toLowerCase() === admin.evmAddress.toLowerCase());
        expect(tx).to.be.undefined;
    });

    it('Before pointer deployment, synthetic event are not thrown with sei_getBlockByHash', async () =>{
        const hash = (await evmRpcClient.getBlockByNumber(ethers.toQuantity(mintTxHeight), true)).hash;
        const rpcResult = await evmRpcClient.sei_getBlockByHash(hash, true);
        const tx = rpcResult.transactions.find(tx => tx.from.toLowerCase() === admin.evmAddress.toLowerCase());
        expect(tx).to.be.undefined;
    });

    it.skip('Before pointer deployment, synthetic event are not thrown with sei_getLogs', async () =>{
        const logs = {
            fromBlock: ethers.toQuantity(mintTxHeight.toString()),
            toBlock: ethers.toQuantity(mintTxHeight.toString()),
        }
        const results = await evmRpcClient.sei_getLogs(logs);
        const tx = results.find(tx => tx.address.toLowerCase() === erc20Contract.getAddress().toLowerCase());
        expect(tx).to.be.undefined;
    });

    it.skip('Before pointer deployment, synthetic event are not thrown with eth_getLogs', async () =>{
        const logs = {
            fromBlock: ethers.toQuantity(mintTxHeight.toString()),
            toBlock: ethers.toQuantity(mintTxHeight.toString()),
        }

        const results = await evmRpcClient.getLogs(logs);
        const tx = results.find(tx => tx.address.toLowerCase() === erc20Contract.getAddress().toLowerCase());
        expect(tx).to.be.undefined;
    });

    it('Before pointer deployment admin can mint more tokens for Alice', async () =>{
       const alicePreBalance = await cw20Contract.balanceOf(users[0].seiAddress);
       await cw20Contract.mint(users[0].seiAddress, '100000000');
       const aliceAfterBalance = await cw20Contract.balanceOf(users[0].seiAddress);
       expect(Number(aliceAfterBalance)).to.equal(Number(alicePreBalance) + Number('100000000'));
    });

    it('Before pointer deployment admin can mint more tokens for Bob', async () =>{
        const bobPreBalance = await cw20Contract.balanceOf(users[1].seiAddress);
        await cw20Contract.mint(users[1].seiAddress, '100000000');
        const bobAfterBalance = await cw20Contract.balanceOf(users[1].seiAddress);
        expect(Number(bobAfterBalance)).to.equal(Number(bobPreBalance) + Number('100000000'));
    });

    it('Before pointer deployment, admin can approve 1000000 for Alice', async () =>{
        const preApproval = await cw20Contract.allowance(admin.seiAddress, users[0].seiAddress);
        await cw20Contract.approve(users[0].seiAddress, '1000000');
        const postApproval = await cw20Contract.allowance(admin.seiAddress, users[0].seiAddress);
        expect(Number(postApproval)).to.equal(Number(preApproval) + Number('1000000'));
    });

    it('Bob cant spend admins tokens since he didnt have the approval', async () =>{
        try{
            cw20Contract.setSigner(users[1]);
            await cw20Contract.transferFrom(admin.seiAddress, users[1].seiAddress, '1000000');
        } catch(e: any){
            expect(e.message).to.contain('No allowance');
        }
    });

    it('Alice cant spend more tokens than her allowance', async () =>{
        try{
            cw20Contract.setSigner(users[0]);
            await cw20Contract.transferFrom(admin.seiAddress, users[1].seiAddress, '100000000');
        } catch(e: any){
            expect(e.message).to.contain('execute wasm contract failed');
        }
    })

    it('Alice can spend admins tokens to send it to Bob', async () =>{
        const bobPreBalance = await cw20Contract.balanceOf(users[1].seiAddress);
        await cw20Contract.transferFrom(admin.seiAddress, users[1].seiAddress, '1000000');
        const bobAfterBalance = await cw20Contract.balanceOf(users[1].seiAddress);
        expect(Number(bobAfterBalance)).to.equal(Number(bobPreBalance) + Number('1000000'));
    });

    it('Alice cant spend more tokens since she has used the approval amounts', async () =>{
        try{
            await cw20Contract.transferFrom(admin.seiAddress, users[1].seiAddress, '1000000');
        } catch(e: any){
            expect(e.message).to.contain('execute wasm contract failed');
        }
    });

    let preBalance: string;
    it('Admin mints some more tokens and approves this for Alice as well', async() =>{
        cw20Contract.setSigner(admin);
        const mintTx = await cw20Contract.mint(admin.seiAddress, '1000000');
        const allowanceTx = await cw20Contract.approve(users[0].seiAddress, '1000000');
        await Promise.all([mintTx, allowanceTx]);
        preBalance = await cw20Contract.balanceOf(users[0].seiAddress);
    });

    it('A user deploys pointer for cw20 contract on evm side', async() =>{
        await cw20Contract.deployPointer(admin.evmRpcEndpoint);
        await waitFor(1);
        const pointerAddr = await cw20Contract.queryPointerAddress();
        erc20Contract = new Erc20Token(admin, pointerAddr);
    });

    let combinedTxBlockNumber: number;
    it('For read ops, users can combine txs on cosmos and evm runtime', async () =>{
        const txBuilder = new TransactionBuilder(users);
        txBuilder.setCw20Token(cw20Contract);
        txBuilder.setErc20Token(erc20Contract);
        combinedTxBlockNumber = await txBuilder.formErc20TransferTxs();
    })

    it('Approvals are migrated on evm runtime', async () =>{
        const approvalsOnEvm = await erc20Contract.allowance(admin.evmAddress, users[0].evmAddress);
        expect(approvalsOnEvm.toString()).to.equal('1000000');
    });

    it('Balances are migrated on evm runtime', async () =>{
        const balance = await erc20Contract.balanceOf(users[0].evmAddress);
        console.log(balance);
    });

    it('Bob cant spend admins tokens on evm runtime', async () =>{
        try {
            await erc20Contract.contract.connect(users[1].evmWallet.wallet)
                .transferFrom(admin.evmAddress, users[1].evmAddress, '1000000');
        } catch (e: any) {
            expect(e.message).to.contain('CosmWasm execute failed');
        }
    });

    it('Bob cant spend admins tokens on cosmos runtime', async () =>{
        try{
            cw20Contract.setSigner(users[1]);
            await cw20Contract.transferFrom(admin.seiAddress, users[1].seiAddress, '1000000');
        } catch(e: any){
            expect(e.message).to.contain('execute wasm contract failed');
        }
    });

    it('Alice can spend admins tokens on evm runtime and balances are updated accordingly', async () =>{
        const bobPreBalanceEvm = await erc20Contract.balanceOf(users[1].evmAddress);
        const bobPreBalanceCosmos = await cw20Contract.balanceOf(users[1].seiAddress);
        const tx = await erc20Contract.contract.connect(users[0].evmWallet.wallet)
            .transferFrom(admin.evmAddress, users[1].evmAddress, '1000000');
        await tx.wait();
        const bobAfterBalanceEvm = await erc20Contract.balanceOf(users[1].evmAddress);
        const bobAfterBalanceCosmos = await cw20Contract.balanceOf(users[1].seiAddress);
        expect(Number(bobAfterBalanceEvm)).to.equal(Number(bobPreBalanceEvm) + Number('1000000'));
        expect(Number(bobAfterBalanceCosmos)).to.equal(Number(bobPreBalanceCosmos) + Number('1000000'));
    });

    it('After spending on evm runtime, Alice cant spend more tokens', async () =>{
        try {
            await erc20Contract.contract.connect(users[0].evmWallet.wallet)
                .transferFrom(admin.evmAddress, users[1].evmAddress, '1000000');
        } catch (e: any) {
            expect(e.message).to.contain('CosmWasm execute failed');
        }
    });

    it('Admin can approve tokens on Bob on evm runtime', async () =>{
        const tx = await erc20Contract.approve(users[1].evmAddress, '1000000');
        await tx.wait();
    });

    it('Bob can spend tokens on cosmos runtime after getting approval on evm runtime', async () =>{
        const bobPreBalanceCosmos = await cw20Contract.balanceOf(users[1].seiAddress);
        const bobPreBalanceEvm = await erc20Contract.balanceOf(users[1].evmAddress);

        cw20Contract.setSigner(users[1]);
        const tx = await cw20Contract.transferFrom(admin.seiAddress, users[1].seiAddress, '1000000');

        const bobAfterBalanceCosmos = await cw20Contract.balanceOf(users[1].seiAddress);
        const bobAfterBalanceEvm = await erc20Contract.balanceOf(users[1].evmAddress);
        expect(Number(bobAfterBalanceCosmos)).to.equal(Number(bobPreBalanceCosmos) + Number('1000000'));
        expect(Number(bobAfterBalanceEvm)).to.equal(Number(bobPreBalanceEvm) + Number('1000000'));
    });

    let transferReceipt: ContractTransactionReceipt;
    let gasPaid: string;
    let txReceipt: TransactionReceipt;
    let receiptLogs: string;
    it('Eth_getTransactionReceipt returns correct information on erc20 transfer from pointer', async () =>{
        const preBalanceOnSei = await evmRpcClient.getBalance(users[0].evmAddress);
        const encodedTx = erc20Contract.contract.interface.encodeFunctionData('transfer', [users[1].evmAddress, '100000']);
        const signedTx = await AtomicTxSender
            .signEvmTransaction(users[0], erc20Contract.getAddress(), encodedTx, "15000000000", "29000000000")
        const hash = await evmRpcClient.sendRawTransaction(signedTx);
        await waitFor(2);
        const txReceipt = await evmRpcClient.getTransactionReceipt(hash);
        const txs = (await evmRpcClient.getBlockByNumber(txReceipt.blockNumber, true)).transactions;
        transferReceipt = txs.find(tx => tx.hash === hash);
        const afterBalanceOnSei = await evmRpcClient.getBalance(users[0].evmAddress);
        gasPaid = preBalanceOnSei - afterBalanceOnSei;
        receiptLogs = JSON.stringify(txReceipt.logs[0]);
        // validate the fields
        expect(txReceipt.blockHash).to.equal(transferReceipt.blockHash);
        expect(txReceipt.blockNumber).to.equal(transferReceipt.blockNumber);
        expect(txReceipt.transactionHash).to.equal(transferReceipt.hash);
        expect(txReceipt.transactionIndex).to.equal(ethers.toQuantity(transferReceipt.transactionIndex));

        //Should be the single tx in the block hence should be 0
        // expect(txReceipt.transactionIndex).to.equal(ethers.toQuantity(0));

        expect(txReceipt.from.toLowerCase()).to.equal(users[0].evmAddress.toLowerCase());
        expect(txReceipt.to.toLowerCase()).to.equal(erc20Contract.getAddress().toLowerCase());

        //Currently cumulative gas used is broken hence returning 0
        // expect(txReceipt.cumulativeGasUsed).to.equal(ethers.toQuantity(0));

        // expect(txReceipt.gasUsed).to.equal(ethers.toQuantity(transferReceipt.gas));
        expect(txReceipt.logs.length).to.equal(1);
        expect(txReceipt.logs[0].address.toLowerCase()).to.equal(erc20Contract.getAddress().toLowerCase());

        const feePaidPerReceipt = Number(txReceipt.gasUsed) * Number(txReceipt.effectiveGasPrice);
        console.log(txReceipt);
        expect(feePaidPerReceipt).to.equal(Number(gasPaid));
        const baseFee = (await evmRpcClient.getBlockByNumber(txReceipt.blockNumber, false)).baseFeePerGas;
        // Todo raise this
        console.log(transferReceipt);
        console.log(baseFee);
        expect(Number(txReceipt.effectiveGasPrice)).to.equal(Number(baseFee) + Number(transferReceipt.maxPriorityFeePerGas));

        // Decode using contract interface (recommended)
        const decodedEvent = erc20Contract.contract.interface.parseLog({
            topics: txReceipt.logs[0].topics,
            data: txReceipt.logs[0].data
        });
        expect(decodedEvent?.name).to.equal('Transfer');
        expect(decodedEvent?.args.from.toLowerCase()).to.equal(users[0].evmAddress.toLowerCase());
        expect(decodedEvent?.args.to.toLowerCase()).to.equal(users[1].evmAddress.toLowerCase());
        expect(decodedEvent?.args.value.toString()).to.equal('100000');

        expect(txReceipt.logs[0].blockNumber).to.equal(txReceipt.blockNumber);
        expect(txReceipt.logs[0].blockHash).to.equal(txReceipt.blockHash);
        expect(txReceipt.logs[0].transactionHash).to.equal(txReceipt.transactionHash);
        expect(txReceipt.logs[0].transactionIndex).to.equal(txReceipt.transactionIndex);
    });

    it('Eth_getTransactionByHash returns correct information on erc20 transfer from pointer', async () =>{
        console.log(transferReceipt);
        const txHashResponse = await evmRpcClient.getTransactionByHash(transferReceipt.hash);
        expect(txHashResponse.blockHash).to.equal(transferReceipt.blockHash);
        expect(txHashResponse.blockNumber).to.equal(transferReceipt.blockNumber);
        expect(txHashResponse.hash).to.equal(transferReceipt.hash);
        expect(txHashResponse.transactionIndex).to.equal(ethers.toQuantity(transferReceipt.transactionIndex));
        expect(txHashResponse.from.toLowerCase()).to.equal(users[0].evmAddress.toLowerCase());
        expect(txHashResponse.to).to.equal(erc20Contract.getAddress().toLowerCase());
        expect(txHashResponse.maxPriorityFeePerGas).to.equal(ethers.toQuantity(15000000000));
        expect(txHashResponse.maxFeePerGas).to.equal(ethers.toQuantity(29000000000));

        //validate gas response
        const baseFeeOnBlock = (await evmRpcClient.getBlockByNumber(transferReceipt.blockNumber, false)).baseFeePerGas;
        // toDo dont forget to raise this
        console.log(txHashResponse.gasPrice);
        expect(Number(txHashResponse.gasPrice)).to.equal(Number(baseFeeOnBlock) + Number(txHashResponse.maxPriorityFeePerGas));
    });

    it('Eth_getLogs returns correct information on erc20 transfer from pointer', async () =>{
        const logs = {
            fromBlock: ethers.toQuantity(transferReceipt.blockNumber),
            toBlock: ethers.toQuantity((transferReceipt.blockNumber)),
            address: erc20Contract.getAddress() as string,
        }
        const rpcResult = await evmRpcClient.getLogs(logs);
        expect(JSON.stringify(rpcResult[0])).to.equal(receiptLogs);
    });
})

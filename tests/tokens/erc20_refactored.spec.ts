import {ContractTransactionReceipt, ethers, TransactionReceipt} from "ethers";
import {SeiUser, UserFactory} from "../../shared/User";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import {expect} from "chai";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {waitFor} from "../../shared/utils/helpers";
import {EvmRpcClient} from "../../shared/RpcClient";
import _, {initial} from "lodash";
import fs from "fs";

describe('Erc20 Tests', function () {
    this.timeout(10 * 60 * 1000);

    let admin: SeiUser, alice: SeiUser, bob: SeiUser;
    let users: SeiUser[];
    let evmRpcClient: EvmRpcClient;
    let erc20Contract: Erc20Token;
    let evmOnlyTxBlock: number;
    let legacyTxBlock: number;
    let adminInitialBalance: bigint, aliceInitialBalance: bigint;
    let txReceipt: ContractTransactionReceipt;
    let legacyTxReceipt: ContractTransactionReceipt;

    before('Deploys contracts and initializes users', async () => {
        admin = await UserFactory.createAdminUser();
        const erc20Address = JSON.parse(fs.readFileSync('./tests/tokens/contractAddresses.json', 'utf8')).erc20Address;
        erc20Contract = new Erc20Token(admin, erc20Address);
        users = await UserFactory.createSeiUsers(admin, 3, true);
        evmRpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
        adminInitialBalance = await erc20Contract.balanceOf(admin.evmAddress);
        alice = users[0];
        aliceInitialBalance = await erc20Contract.balanceOf(alice.evmAddress);
        bob = users[1];
    });

    describe('Write ops for erc20 tests', function () {

        it('Given that an erc20 deployed, admin can mint tokens', async () => {
            const mintTx = await erc20Contract.mint(admin.evmAddress, ethers.parseEther('1000').toString());
            await mintTx.wait();
            const balance = await erc20Contract.balanceOf(admin.evmAddress);
            expect(balance.toString()).to.equal((adminInitialBalance + ethers.parseEther('1000')).toString());
        });

        it('Given that an erc20 deployed admin can mint tokens with legacy txs', async () => {
            const legacyTx = erc20Contract.contract.interface.encodeFunctionData("mint",
                [admin.evmAddress, ethers.parseEther('500').toString()]
            );

            const gasPrice = await admin.evmWallet.signingClient.getFeeData();
            const txResponse = await admin.evmWallet.wallet.sendTransaction({
                to: erc20Contract.contract.getAddress(),
                data: legacyTx,
                type: 0,
                gasPrice: gasPrice.gasPrice,
            });
            legacyTxReceipt = await txResponse.wait() as ContractTransactionReceipt;
            expect(legacyTxReceipt.status).to.equal(1);
            const balance = await erc20Contract.balanceOf(admin.evmAddress);
            expect(balance.toString()).to.equal((adminInitialBalance + ethers.parseEther('1500')).toString());
            legacyTxBlock = legacyTxReceipt.blockNumber;
        });

        it('Given that an erc20 deployed with open mint alice can mint tokens', async () => {
            const tx = await erc20Contract.contract.connect(alice.evmWallet.wallet)
                .mint(alice.evmAddress, ethers.parseEther('1000'), {gasLimit: 1000000});
            txReceipt = await tx.wait();
            const balance = await erc20Contract.balanceOf(alice.evmAddress);
            evmOnlyTxBlock = txReceipt.blockNumber;
            expect(balance.toString()).to.equal((aliceInitialBalance + ethers.parseEther('1000')).toString());
        });

        it('Given that an erc20 deployed admin can transfer tokens to Alice', async () => {
            const transferTx = await erc20Contract.transfer(alice.evmAddress, ethers.parseEther('500').toString());
            await transferTx.wait();
            const balance = await erc20Contract.balanceOf(alice.evmAddress);
            expect(balance.toString()).to.equal((aliceInitialBalance + ethers.parseEther('1500')).toString());
        });

        it('Given that an erc20 deployed admin can set an allowance for Alice to spend tokens', async () => {
            const allowanceTx = await erc20Contract.approve(alice.evmAddress, ethers.parseEther('500').toString());
            const receipt = await allowanceTx.wait();
            const allowance = await erc20Contract.allowance(admin.evmAddress, alice.evmAddress);
            expect(allowance.toString()).to.equal(ethers.parseEther('500').toString());
        });

        it('Alice cant spend more than allowed to send tokens to Bob', async () => {
            try {
                const transferTx = await erc20Contract.contract.connect(alice.evmWallet.wallet)
                    .transferFrom(admin.evmAddress, bob.evmAddress, ethers.parseEther('1000').toString(), {gasLimit: 1000000});
                await transferTx.wait();
                throw new Error('Transfer should have failed');
            } catch (e: any) {
                expect(e.message).to.include('execution reverted');
                await waitFor(1);
            }
        });

        it('Alice can spend tokens within her allowance to send tokens to Bob', async () => {
            const bobInitialBalance = await erc20Contract.balanceOf(bob.evmAddress);
            const transferTx = await erc20Contract.contract.connect(alice.evmWallet.wallet)
                .transferFrom(admin.evmAddress, bob.evmAddress, ethers.parseEther('400').toString(), {gasLimit: 1000000});
            const receipt = await transferTx.wait();
            const balance = await erc20Contract.balanceOf(bob.evmAddress);
            expect(balance.toString()).to.equal((bobInitialBalance + ethers.parseEther('400')).toString());
        });

        it('Admin queries name of the contract', async () => {
            const name = await erc20Contract.name();
            expect(name).to.be.eq('MyToken');
        });

        it('Admin queries symbol of the contract', async () => {
            const symbol = await erc20Contract.symbol();
            expect(symbol).to.be.eq('MTK');
        });

        it('Admin queries the decimals of the contract', async () => {
            const decimals = await erc20Contract.decimals();
            expect(Number(decimals)).to.be.eq(18);
        });

        it('Association preserves the balances on erc20', async () =>{
            const newUser = await UserFactory.createSeiUser(admin, 'newUser');
            const fundTx = await erc20Contract.transfer(newUser.evmAddress, ethers.parseEther('100').toString());
            await fundTx.wait();
            const newUserBalance = await erc20Contract.balanceOf(newUser.evmAddress);
            expect(newUserBalance.toString()).to.be.eq(ethers.parseEther('100').toString());

            await newUser.seiWallet.associate();
            const newUserBalanceAfterAssociation = await erc20Contract.balanceOf(newUser.evmAddress);
            expect(newUserBalanceAfterAssociation.toString()).to.be.eq(ethers.parseEther('100').toString());
        });

        it('Users cant deploy pointers on wasm runtime for erc20', async () => {
            const pointer = await erc20Contract.deployPointer(alice.evmAddress);
            expect(pointer).not.to.contain('sei');
        })
    });

    describe('Rpc tests for Erc20 ', function () {

        describe('Block tests for erc20 events', function () {
            let legacyTxHash: string;
            it('eth get block by number returns info on evm erc20 legacy txs', async () => {
                const rpcResponse = await evmRpcClient.getBlockByNumber(ethers.toQuantity(legacyTxBlock), true);
                const mintTx = rpcResponse.transactions
                    .find(tx => tx.from.toLowerCase() === admin.evmAddress.toLowerCase());
                legacyTxHash = mintTx.hash;

                expect(mintTx.to.toLowerCase()).to.be.eq(erc20Contract.getAddress().toLowerCase());
                const input = erc20Contract.contract.interface.decodeFunctionData("mint", mintTx.input);
                expect(input[0].toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
                expect(input[1].toString()).to.be.eq(ethers.parseEther('500').toString());
                expect(Number(mintTx.gas)).to.be.gte(Number(legacyTxReceipt.gasUsed));
                expect(mintTx.blockHash).to.be.eq(rpcResponse.hash);
                expect(Number(mintTx.blockNumber)).to.be.eq(legacyTxBlock);
                expect(Number(mintTx.transactionIndex)).to.be.eq(legacyTxReceipt.index);
                expect(Number(mintTx.gasPrice)).to.be.eq(Number(legacyTxReceipt.gasPrice));
                expect(Number(mintTx.type)).to.be.eq(0);
            });

            it('eth get block receipts match the info for evm erc20 legacy txs', async () => {
                const txReceipt = await evmRpcClient.getTransactionReceipt(legacyTxHash);
                const rpcResult = await evmRpcClient.getBlockReceipts(ethers.toQuantity(legacyTxBlock));
                const mintTx = rpcResult.find(tx => tx.from.toLowerCase() === admin.evmAddress.toLowerCase());
                expect(_.isEqual(mintTx, txReceipt)).to.be.true;
            });

            it('eth get block by number returns info on evm erc20 txs', async () =>{
                const txInfo = await evmRpcClient.getBlockByNumber(ethers.toQuantity(evmOnlyTxBlock), true);
                const tx = txInfo.transactions.find(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase());
                expect(Number(tx.type)).to.be.eq(2);
                console.log(tx);
                console.log('*****');
                console.log(txReceipt);
                expect(tx.to.toLowerCase()).to.be.eq(erc20Contract.getAddress().toLowerCase());
                const input = erc20Contract.contract.interface.decodeFunctionData("mint", tx.input);
                expect(input[0].toLowerCase()).to.be.eq(alice.evmAddress.toLowerCase());
                expect(input[1].toString()).to.be.eq(ethers.parseEther('1000').toString());
                expect(Number(tx.gas)).to.be.gte(Number(txReceipt.gasUsed));
                expect(tx.blockHash).to.be.eq(txReceipt.blockHash);
                expect(Number(tx.blockNumber)).to.be.eq(txReceipt.blockNumber);
                expect(Number(tx.transactionIndex)).to.be.eq(txReceipt.index);
                expect(Number(tx.gasPrice)).to.be.eq(Number(txReceipt.gasPrice));
            });

            it('eth get block by hash returns info on evm erc20 txs', async () =>{
                const blockHash = (await evmRpcClient.getBlockByNumber(ethers.toQuantity(evmOnlyTxBlock), true)).hash;
                const rpcResult = await evmRpcClient.getBlockByHash(blockHash, true);
                const tx = rpcResult.transactions.find(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase());
                expect(Number(tx.type)).to.be.eq(2);
                expect(tx.to.toLowerCase()).to.be.eq(erc20Contract.getAddress().toLowerCase());
                const input = erc20Contract.contract.interface.decodeFunctionData("mint", tx.input);
                expect(input[0].toLowerCase()).to.be.eq(alice.evmAddress.toLowerCase());
                expect(input[1].toString()).to.be.eq(ethers.parseEther('1000').toString());
            });

            it('sei get block by number returns info on evm erc20 txs', async () =>{
                const rpcResult = await evmRpcClient.sei_getBlockByNumber(ethers.toQuantity(evmOnlyTxBlock), true);
                const txs = rpcResult.transactions.filter(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase());
                expect(txs.length).to.be.gte(1);
                for (const tx of txs){
                    expect(tx.from.toLowerCase()).to.be.eq(alice.evmAddress.toLowerCase());
                    expect(Number(tx.blockNumber)).to.be.eq(Number(evmOnlyTxBlock));
                    expect(Number(tx.type)).to.be.eq(2);
                    expect(Number(tx.value)).to.be.eq(0);
                    expect(tx.to.toLowerCase()).to.be.eq(erc20Contract.getAddress().toLowerCase());
                    expect(tx.input.length).to.be.gt(0);
                }
            });

            it('sei get block by hash returns info on erc erc20 txs', async () =>{
                const blockHash = (await evmRpcClient.getBlockByNumber(ethers.toQuantity(evmOnlyTxBlock), true)).hash;
                const rpcResult = await evmRpcClient.sei_getBlockByHash(blockHash, true);
                const txs = rpcResult.transactions.filter(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase());
                expect(txs.length).to.be.gte(1);
                for (const tx of txs){
                    expect(tx.from.toLowerCase()).to.be.eq(alice.evmAddress.toLowerCase());
                    expect(Number(tx.blockNumber)).to.be.eq(evmOnlyTxBlock);
                    expect(Number(tx.type)).to.be.eq(2);
                    expect(Number(tx.value)).to.be.eq(0);
                    expect(tx.to.toLowerCase()).to.be.eq(erc20Contract.getAddress().toLowerCase());
                    expect(tx.input.length).to.be.gt(0);
                }
            });

            it('eth get block receipts only return info on evm erc20 txs', async () =>{
                const receipts = await evmRpcClient.getBlockReceipts(ethers.toQuantity(evmOnlyTxBlock));
                const txs = receipts.filter(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase());
                expect(txs.length).to.be.eq(1);
            });
        });

        describe('Logs endpoints for erc20 events', function () {
            const topic = ethers.id('Transfer(address,address,uint256)')
            let seiLogs: any, evmLogs: any;


            before('Sets logs', async () =>{
                evmLogs = {
                    fromBlock: ethers.toQuantity(Number(evmOnlyTxBlock) - 1),
                    toBlock: ethers.toQuantity(Number(evmOnlyTxBlock) + 1),
                    topics: [topic],
                    address: erc20Contract.getAddress() as string
                }
                const curentBlock = await evmRpcClient.getBlockNumber();
                seiLogs = {
                    fromBlock: ethers.toQuantity(Number(evmOnlyTxBlock) - 1),
                    toBlock: ethers.toQuantity(Number(evmOnlyTxBlock) + 1),
                    address: erc20Contract.getAddress(),
                    topics: [topic],
                }
            });

            it('Eth logs endpoint returns info on evm erc20 txs', async () =>{
                // expected count is 1
                const logResults = await evmRpcClient.getLogs(evmLogs);
                expect(logResults.length).to.be.eq(1);
            });

            it('Eth filter logs returns info on evm erc20 txs', async () =>{
                const newFilter = await evmRpcClient.eth_newFilter(evmLogs);
                await waitFor(2);
                const filterResults = await evmRpcClient.eth_getFilterLogs(newFilter);
                expect(filterResults.length).to.be.eq(1);
            });

            it('Sei logs endpoint returns info on wasm erc20 txs', async () =>{
                const logs = await evmRpcClient.sei_getLogs(seiLogs);
                expect(logs.length).to.be.eq(1);
            });

            it('Sei filter logs returns info on wasm erc20 txs', async () =>{
                const filterId = await evmRpcClient.sei_newFilter(seiLogs);
                const logs = await evmRpcClient.sei_getFilterLogs(filterId);
                expect(logs.length).to.be.eq(1);
            });
        });

        describe('Debug endpoints for erc20 events', function () {
            let txHash: string;
            it('Debug trace block returns correct block info on evm txs', async () =>{
                const rpcData = await evmRpcClient.getBlockByNumber(ethers.toQuantity(evmOnlyTxBlock), true);
                txHash = rpcData.transactions.find(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase()).hash;
                const debugTraceBlock = await evmRpcClient.debugTraceByBlockNumber(ethers.toQuantity(evmOnlyTxBlock), {disableStorage: false});
                expect(debugTraceBlock.length).to.be.gte(1);
            });

            it('Debug trace tx returns correct tx info on evm txs', async () =>{
                const txData = await evmRpcClient.debugTraceTransaction(txHash, {disableStorage: false});
                expect(txData.gas).to.be.gt(10000);
                expect(txData.failed).to.be.false;
            });
        });
    });
})

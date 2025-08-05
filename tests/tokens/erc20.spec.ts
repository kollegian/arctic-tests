import {ContractTransactionReceipt, ethers, TransactionReceipt} from "ethers";
import {SeiUser, UserFactory} from "../../shared/User";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import {expect} from "chai";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {waitFor} from "../../shared/utils/helpers";
import {EvmRpcClient} from "../../shared/RpcClient";
import _, {initial} from "lodash";

describe('Erc20 Tests', function () {
    this.timeout(10 * 60 * 1000);

    let admin: SeiUser, alice: SeiUser, bob: SeiUser;
    let rpcClient: EvmRpcClient;
    let erc20Contract: Erc20Token;
    let erc20PointerContract: Cw20Token;
    let evmOnlyTxBlock: number;
    let wasmOnlyTxBlock: number;
    let evmAndWasmTxBlock: number;
    let legacyTxBlock: number;
    let allowanceTxBlock: number;
    let multipleWasmEventsInASingleBlock: number;
    let adminInitialBalance: bigint, aliceInitialBalance: bigint;

    before('Deploys contracts and initializes users', async () => {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        ([alice, bob] = await UserFactory.createSeiUsers(admin, 2));
        const deployer = new TokenDeployer(admin);
        erc20Contract = await deployer.deployErc20();
        rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
        adminInitialBalance = await erc20Contract.balanceOf(admin.evmAddress);
        aliceInitialBalance = await erc20Contract.balanceOf(alice.evmAddress);
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

            // Set the transaction type to 0 (legacy) and specify gasPrice instead of maxFeePerGas
            const gasPrice = await admin.evmWallet.signingClient.getFeeData();
            const txResponse = await admin.evmWallet.wallet.sendTransaction({
                to: erc20Contract.contract.getAddress(), // the ERC20 contract
                data: legacyTx,
                type: 0,
                gasPrice: gasPrice.gasPrice,
            });
            const receipt = await txResponse.wait() as TransactionReceipt;
            expect(receipt.status).to.equal(1);
            console.log('Legacy tx hash is ', receipt.hash);
            const balance = await erc20Contract.balanceOf(admin.evmAddress);
            expect(balance.toString()).to.equal((adminInitialBalance + ethers.parseEther('1500')).toString());
            legacyTxBlock = receipt.blockNumber;
        });

        it('Given that an erc20 deployed with open mint alice can mint tokens', async () => {
            const tx = await erc20Contract.contract.connect(alice.evmWallet.wallet)
                .mint(alice.evmAddress, ethers.parseEther('1000'), {gasLimit: 1000000});
            const receipt = await tx.wait();
            const balance = await erc20Contract.balanceOf(alice.evmAddress);
            evmOnlyTxBlock = receipt.blockNumber;
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
            allowanceTxBlock = receipt.blockNumber;
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
            }
        });

        it('Alice can spend tokens within her allowance to send tokens to Bob', async () => {
            const transferTx = await erc20Contract.contract.connect(alice.evmWallet.wallet)
                .transferFrom(admin.evmAddress, bob.evmAddress, ethers.parseEther('400').toString(), {gasLimit: 1000000});
            const receipt = await transferTx.wait();
            const balance = await erc20Contract.balanceOf(bob.evmAddress);
            expect(balance.toString()).to.equal(ethers.parseEther('400').toString());
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

        it('Admin deploys pointer for the erc20 contract', async () => {
            const pointer = await erc20Contract.deployPointer(admin.evmRpcEndpoint);
            erc20PointerContract = new Cw20Token(admin, pointer);
            console.log('Pointer address is ', pointer);
        });

        it('Admin balances are migrated correctly', async () => {
            const adminBalance = await erc20PointerContract.balanceOf(admin.seiAddress);
            expect(adminBalance.toString()).to.equal((adminInitialBalance + ethers.parseEther('600')).toString());
        });

        it('Admin approvals are migrated correctly', async () => {
            const aliceAllowance = await erc20PointerContract.allowance(admin.seiAddress, alice.seiAddress);
            expect(aliceAllowance.toString()).to.equal(ethers.parseEther('100').toString());
        });

        it('Alice balances are migrated correctly', async () => {
            const aliceBalance = await erc20PointerContract.balanceOf(alice.seiAddress);
            expect(aliceBalance.toString()).to.equal(ethers.parseEther('1500').toString());
        });

        it('Alice can spend on admins behalf on cosmos runtime', async () => {
            // At this point Alice has 100 allowance
            erc20PointerContract.setSigner(alice);
            const transferTx = await erc20PointerContract.transferFrom(admin.seiAddress, bob.seiAddress, ethers.parseEther('100').toString());
            const bobBalance = await erc20PointerContract.balanceOf(bob.seiAddress);
            expect(bobBalance.toString()).to.equal(ethers.parseEther('500').toString());
        });

        it('Users can query token info on wasm runtime', async () => {
            const name = await erc20PointerContract.tokenInfo();
            console.log(name);
        });


        it('Admin can transfer tokens on wasm runtime and balances are updated accordingly', async () => {
            //Admin has 600 tokens
            erc20PointerContract.setSigner(admin);
            const transferTx = await erc20PointerContract.transfer(alice.seiAddress, ethers.parseEther('500').toString());
            const aliceBalance = await erc20PointerContract.balanceOf(alice.seiAddress);
            expect(aliceBalance.toString()).to.equal(ethers.parseEther('2000').toString());

            //evm balance
            const aliceBalanceOnEvm = await erc20Contract.balanceOf(alice.evmAddress);
            expect(aliceBalanceOnEvm.toString()).to.equal(ethers.parseEther('2000').toString());
        });

        it('Alice transfers tokens on wasm runtime and evm runtime in the same block', async () => {
            const adminPreBalance = await erc20PointerContract.balanceOf(admin.seiAddress);
            const encodedTx = erc20Contract.contract.interface.encodeFunctionData("transfer", [admin.evmAddress, ethers.parseEther('400').toString()]);
            const signedTx = await AtomicTxSender.signEvmTransaction(alice, erc20Contract.getAddress(), encodedTx);
            const delayed = async () => {
                await waitFor(0.01)
                return AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin);
            }
            erc20PointerContract.setSigner(alice);
            const results = await Promise.all([
                delayed(),
                erc20PointerContract.transfer(admin.seiAddress, ethers.parseEther('100').toString())
            ])
            const block1 = await admin.evmWallet.signingClient.getTransactionReceipt(results[0]) as TransactionReceipt;
            const block2 = results[1].height;
            expect(Number(block1.blockNumber)).to.equal(block2);
            evmAndWasmTxBlock = block2;

            const adminBalance = await erc20PointerContract.balanceOf(admin.seiAddress);
            expect(adminBalance.toString()).to.equal((adminInitialBalance + ethers.parseEther('500')).toString());

            const adminEvmBalance = await erc20Contract.balanceOf(admin.evmAddress);
            expect(adminEvmBalance.toString()).to.equal((adminInitialBalance + ethers.parseEther('500')).toString());
        });

        it('Alice transfers multiple tokens on wasm runtime in a single tx and balances are updated accordingly', async () => {
            const alicePreBalance = await erc20Contract.balanceOf(alice.evmAddress);
            const adminPreBalance = await erc20Contract.balanceOf(admin.evmAddress);
            const msgs = [
                {contractAddress: erc20PointerContract.getAddress(),
                    msg: { transfer: { recipient: admin.seiAddress, amount: ethers.parseEther('100').toString() }}},
                {contractAddress: erc20PointerContract.getAddress(),
                    msg: { transfer: { recipient: bob.seiAddress, amount: ethers.parseEther('100').toString() }}}
            ];

            const receipt = await erc20PointerContract.execMultiple(msgs);
            multipleWasmEventsInASingleBlock = receipt.height;

            const aliceAfterBalance = await erc20Contract.balanceOf(alice.evmAddress);
            const adminAfterBalance = await erc20Contract.balanceOf(admin.evmAddress);
            expect(aliceAfterBalance.toString()).to.equal((alicePreBalance - ethers.parseEther('200')).toString());
            expect(adminAfterBalance.toString()).to.equal((adminPreBalance + ethers.parseEther('100')).toString());
        });

        it('Admin approves Bob on wasm runtime', async () => {
            erc20PointerContract.setSigner(admin);
            const allowance = await erc20PointerContract.approve(bob.seiAddress, ethers.parseEther('100').toString());
            const allowanceOnEvm = await erc20Contract.allowance(admin.evmAddress, bob.evmAddress);
            wasmOnlyTxBlock = allowance.height;
            expect(allowanceOnEvm.toString()).to.equal(ethers.parseEther('100').toString());
        });


        it('Bob can use approvals to send tokens on evm runtime', async () => {
            const alicePreBalance = await erc20Contract.balanceOf(alice.evmAddress);
            const adminPreBalance = await erc20Contract.balanceOf(admin.evmAddress);

            const tx = await erc20Contract.contract.connect(bob.evmWallet.wallet)
                .transferFrom(admin.evmAddress, alice.evmAddress, ethers.parseEther('100').toString());
            const receipt = await tx.wait();

            const aliceAfterBalance = await erc20Contract.balanceOf(alice.evmAddress);
            const adminAfterBalance = await erc20Contract.balanceOf(admin.evmAddress);
            expect(aliceAfterBalance.toString()).to.equal((alicePreBalance + ethers.parseEther('100')).toString());
            expect(adminAfterBalance.toString()).to.equal((adminPreBalance - ethers.parseEther('100')).toString());

            const aliceBalanceOnWasm = await erc20PointerContract.balanceOf(alice.seiAddress);
            expect(aliceBalanceOnWasm.toString()).to.equal(aliceAfterBalance.toString());
        });

    });

    describe('Rpc tests for Erc20 ', function () {

        describe('Block tests for erc20 events', function () {
            let legacyTxHash: string;
            it('eth get block by number returns info on evm erc20 legacy txs', async () => {
                const rpcResponse = await rpcClient.getBlockByNumber(ethers.toQuantity(legacyTxBlock), true);
                const mintTx = rpcResponse.transactions
                    .find(tx => tx.from.toLowerCase() === admin.evmAddress.toLowerCase());
                expect(Number(mintTx.type)).to.be.eq(0);
                expect(mintTx.to.toLowerCase()).to.be.eq(erc20Contract.getAddress().toLowerCase());
                const input = erc20Contract.contract.interface.decodeFunctionData("mint", mintTx.input);
                expect(input[0].toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
                expect(input[1].toString()).to.be.eq(ethers.parseEther('500').toString());
                legacyTxHash = mintTx.hash;
            });

            it('eth get block receipts match the info for evm erc20 legacy txs', async () => {
                const txReceipt = await rpcClient.getTransactionReceipt(legacyTxHash);
                const rpcResult = await rpcClient.getBlockReceipts(ethers.toQuantity(legacyTxBlock));
                const mintTx = rpcResult.find(tx => tx.from.toLowerCase() === admin.evmAddress.toLowerCase());
                expect(_.isEqual(mintTx, txReceipt)).to.be.true;
            });

            it('eth get block by number returns info on evm erc20 txs', async () =>{
                const txInfo = await rpcClient.getBlockByNumber(ethers.toQuantity(evmOnlyTxBlock), true);
                const tx = txInfo.transactions.find(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase());
                expect(Number(tx.type)).to.be.eq(2);
                expect(tx.to.toLowerCase()).to.be.eq(erc20Contract.getAddress().toLowerCase());
                const input = erc20Contract.contract.interface.decodeFunctionData("mint", tx.input);
                expect(input[0].toLowerCase()).to.be.eq(alice.evmAddress.toLowerCase());
                expect(input[1].toString()).to.be.eq(ethers.parseEther('1000').toString());
            });

            it('eth get block by hash returns info on evm erc20 txs', async () =>{
                const blockHash = (await rpcClient.getBlockByNumber(ethers.toQuantity(evmOnlyTxBlock), true)).hash;
                const rpcResult = await rpcClient.getBlockByHash(blockHash, true);
                const tx = rpcResult.transactions.find(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase());
                expect(Number(tx.type)).to.be.eq(2);
                expect(tx.to.toLowerCase()).to.be.eq(erc20Contract.getAddress().toLowerCase());
                const input = erc20Contract.contract.interface.decodeFunctionData("mint", tx.input);
                expect(input[0].toLowerCase()).to.be.eq(alice.evmAddress.toLowerCase());
                expect(input[1].toString()).to.be.eq(ethers.parseEther('1000').toString());
            });

            it('sei get block by number returns info on both wasm and evm erc20 txs', async () =>{
                const rpcResult = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(evmAndWasmTxBlock), true);
                const txs = rpcResult.transactions.filter(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase());
                expect(txs.length).to.be.eq(2);
                console.log(txs);
                for (const tx of txs){
                    expect(tx.from.toLowerCase()).to.be.eq(alice.evmAddress.toLowerCase());
                    expect(Number(tx.blockNumber)).to.be.eq(Number(evmAndWasmTxBlock));
                    expect(Number(tx.type)).to.be.oneOf([0, 1]);
                    expect(Number(tx.value)).to.be.eq(0);
                    expect(tx.to.toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(tx.input.length).to.be.gt(0);
                }
            });

            it('sei get block by hash returns info on wasm erc20 txs', async () =>{
                const blockHash = (await rpcClient.getBlockByNumber(ethers.toQuantity(evmAndWasmTxBlock), true)).hash;
                const rpcResult = await rpcClient.sei_getBlockByHash(blockHash, true);
                const txs = rpcResult.transactions.filter(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase());
                expect(txs.length).to.be.eq(2);
                for (const tx of txs){
                    expect(tx.from.toLowerCase()).to.be.eq(alice.evmAddress.toLowerCase());
                    expect(Number(tx.blockNumber)).to.be.eq(evmAndWasmTxBlock);
                    expect(Number(tx.type)).to.be.oneOf([0,1]);
                    expect(Number(tx.value)).to.be.eq(0);
                    expect(tx.to.toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(tx.input.length).to.be.gt(0);
                }
            });

            it('eth get block receipts only return info on evm erc20 txs', async () =>{
                const receipts = await rpcClient.getBlockReceipts(ethers.toQuantity(evmAndWasmTxBlock));
                const txs = receipts.filter(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase());
                expect(txs.length).to.be.eq(1);
            });
        });

        describe('Logs endpoints for erc20 events', function () {
            const topic = ethers.id('Transfer(address,address,uint256)')
            let seiLogs: any, evmLogs: any;


            before('Sets logs', async () =>{
                evmLogs = {
                    fromBlock: ethers.toQuantity(Number(evmAndWasmTxBlock) - 1),
                    toBlock: ethers.toQuantity(Number(evmAndWasmTxBlock) + 1),
                    topics: [topic],
                    address: erc20Contract.getAddress() as string
                }

                seiLogs = {
                    fromBlock: ethers.toQuantity(Number(evmAndWasmTxBlock) - 1),
                    toBlock: ethers.toQuantity(Number(evmAndWasmTxBlock) + 1),
                    address: erc20Contract.getAddress(),
                    topics: [topic],
                }
            });

            it('Eth logs endpoint returns info on evm erc20 txs', async () =>{
                console.log('Coming from logs');
                // expected count is 1
                const logResults = await rpcClient.getLogs(evmLogs);
                expect(logResults.length).to.be.eq(1);
            });

            it('Eth filter logs returns info on evm erc20 txs', async () =>{
                const newFilter = await rpcClient.eth_newFilter(evmLogs);
                const filterResults = await rpcClient.eth_getFilterLogs(newFilter);
                expect(filterResults.length).to.be.eq(1);
            });

            it('Sei logs endpoint returns info on wasm erc20 txs', async () =>{
                const logs = await rpcClient.sei_getLogs(seiLogs);
                expect(logs.length).to.be.eq(2);
            });

            it('Sei filter logs returns info on wasm erc20 txs', async () =>{
                const filterId = await rpcClient.sei_newFilter(seiLogs);
                const logs = await rpcClient.sei_getFilterLogs(filterId);
                expect(logs.length).to.be.eq(2);
            });
        });

        describe('Debug endpoints for erc20 events', function () {
            let txHash: string;
            it('Debug trace block returns correct block info on evm txs', async () =>{
                const rpcData = await rpcClient.getBlockByNumber(ethers.toQuantity(evmAndWasmTxBlock), true);
                txHash = rpcData.transactions.find(tx => tx.from.toLowerCase() === alice.evmAddress.toLowerCase()).hash;
                const debugTraceBlock = await rpcClient.debugTraceByBlockNumber(ethers.toQuantity(evmAndWasmTxBlock), {disableStorage: false});
                expect(debugTraceBlock.length).to.be.gte(1);
            });

            it('Debug trace tx returns correct tx info on evm txs', async () =>{
                const txData = await rpcClient.debugTraceTransaction(txHash, {disableStorage: false});
                expect(txData.gas).to.be.gt(10000);
                expect(txData.failed).to.be.false;
            });
        });
    });
})

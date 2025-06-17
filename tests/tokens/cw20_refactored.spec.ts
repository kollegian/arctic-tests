import { SeiUser, User, UserFactory } from "../../shared/User";
import * as TestConfig from "../../config/testConfig.json";
import { TokenDeployer } from "../../shared/Deployer";
import { Cw20Token, Erc20Token } from "../../shared/Token";
import { EvmRpcClient } from "../../shared/RpcClient";
import { ethers } from "ethers";
import { expect } from "chai";
import { AtomicTxSender } from "../../shared/TxBuilder";
import pointerAbi from "../../artifacts/contracts/CW20ERC20Pointer.sol/CW20ERC20Pointer.json";
import { CW20ERC20Pointer } from "../../typechain-types";
import { waitFor } from "../../shared/utils/helpers";
import { DeliverTxResponse } from "@cosmjs/stargate";
import { ExecuteResult } from "@cosmjs/cosmwasm-stargate";

describe('CW20 Token Tests', function () {
    let admin: SeiUser, alice: SeiUser, bob: SeiUser, eve: SeiUser;
    let cw20Contract: Cw20Token;
    let rpcClient: EvmRpcClient;
    let pointerContract: CW20ERC20Pointer;
    let pointerContractAddress: string;
    let mintTx: ExecuteResult;
    let burnTx: ExecuteResult;
    let approveTx: ExecuteResult;
    let multipleMintTxPrePointer: DeliverTxResponse;
    let twoMintsWithSeparateTxHeightPrePointer: DeliverTxResponse;
    let transferFilterId: string;

    const topic = ethers.id('Transfer(address,address,uint256)');
    const approvalTopic = ethers.id('Approval(address,address,uint256)');
    const rpcCalls = ['sei_getLogs', 'sei_getFilterLogs', 'sei_getBlockByHash', 'sei_getBlockByNumber', 'eth_getLogs',
        'eth_getFilterLogs', 'eth_getBlockByHash', 'eth_getBlockByNumber'];

    this.timeout(12 * 60 * 1000);

    before('Initialize users and deploy CW20 contract', async () => {
        // Initialize admin user
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        await waitFor(1);

        // Initialize users
        [alice, bob, eve] = await UserFactory.createSeiUsers(admin, 3);

        // Deploy CW20 contract
        const deployer = new TokenDeployer(admin);
        cw20Contract = await deployer.deployCw20('wasm/cw20_base.wasm', {
            name: 'myCw20',
            symbol: 'myCw',
            decimals: 6,
            initial_balances: [{ address: alice.seiAddress, amount: '1000000' }],
        }, 'myCw20');

        // Initialize RPC client
        rpcClient = new EvmRpcClient(TestConfig.evmRpcEndpoint, admin.evmWallet.signingClient);
    });

    describe('CW20 operations before pointer deployment', () => {
        it('Alice mints cw20 tokens to her address on sei runtime', async () => {
            const amountToMint = '1000000';
            mintTx = await cw20Contract.mint(alice.seiAddress, amountToMint);
            const balance = await cw20Contract.balanceOf(alice.seiAddress);
            expect(balance).to.equal(amountToMint);
        });

        it('Alice can multiple mint tokens to her address on sei runtime', async () => {
            const aliceBalance = await cw20Contract.balanceOf(alice.seiAddress);
            const amounts = ['100000', '100000'];
            multipleMintTxPrePointer = await cw20Contract.mintMultiple([alice.seiAddress, alice.seiAddress], amounts);
            const aliceAfterBalance = await cw20Contract.balanceOf(alice.seiAddress);
            expect(Number(aliceAfterBalance)).to.equal(Number(aliceBalance) + 200000);
        });

        it('Alice can transfer available amount to eve sei address on sei runtime', async () => {
            const transferAmount = '500000';
            await cw20Contract.transfer(eve.seiAddress, transferAmount);
            const eveBalance = await cw20Contract.balanceOf(eve.seiAddress);
            expect(eveBalance).to.equal(transferAmount);
        });

        it('Alice cannot transfer more than her remaining balance to eve sei address on sei runtime', async () => {
            const transferAmount = '2000000';
            try {
                await cw20Contract.transfer(eve.seiAddress, transferAmount);
                throw new Error('Transfer should have failed');
            } catch (e: any) {
                expect(e.message).to.include('Transfer failed');
            }
        });

        it('Alice burns amounts from her remaining balance on sei runtime', async () => {
            const burnAmount = '100';
            const preBalance = await cw20Contract.balanceOf(alice.seiAddress);
            burnTx = await cw20Contract.burn(burnAmount);
            const balance = await cw20Contract.balanceOf(alice.seiAddress);
            expect(Number(balance)).to.equal(Number(preBalance) - Number(burnAmount));
        });

        it('Alice can call multiple mint tx on sei runtime with two different tx hashes', async () => {
            const mint1 = {
                mint: {
                    recipient: alice.seiAddress,
                    amount: '100000',
                }
            };

            const mint2 = {
                mint: {
                    recipient: alice.seiAddress,
                    amount: '100000',
                }
            };

            const alicePreBalance = await cw20Contract.balanceOf(alice.seiAddress);
            const txResults = await cw20Contract.executeMultipleInTheSameBlock([mint1, mint2]);
            twoMintsWithSeparateTxHeightPrePointer = txResults[0];

            const aliceAfterBalance = await cw20Contract.balanceOf(alice.seiAddress);
            expect(Number(aliceAfterBalance)).to.equal(Number(alicePreBalance) + Number(200000));
        });

        it('Alice approves Bob to spend her tokens on sei runtime on her behalf', async () => {
            approveTx = await cw20Contract.approve(bob.seiAddress, '1000');
            const allowance = await cw20Contract.allowance(alice.seiAddress, bob.seiAddress);
            expect(Number(allowance)).to.equal(1000);
        });

        it('Alice registers a filter on evm to listen transfer events', async () => {
            const currentBlock = await rpcClient.eth_blockNumber();
            const logParams = {
                fromBlock: ethers.toQuantity(currentBlock),
                toBlock: 'latest',
                topics: [topic],
            };
            transferFilterId = await rpcClient.sei_newFilter(logParams);
            expect(transferFilterId).to.not.be.empty;
        });

        // Check that no synthetic events are thrown before pointer deployment
        for (const syntheticEvent of rpcCalls) {
            it(`Before deploying pointer, Alice won't see any synthetic events thrown on evm runtime with ${syntheticEvent} for mint event`, async () => {
                const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, mintTx, topic);
                expect(rpcResult.length).to.equal(0, 'Transactions found when none was expected');
            });

            it(`Before deploying pointer, Alice won't see any synthetic events thrown on evm runtime with ${syntheticEvent} for burn event`, async () => {
                const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, burnTx, topic);
                expect(rpcResult.length).to.equal(0, 'Transactions found when none was expected');
            });

            it(`Before deploying pointer, Alice won't see any synthetic events thrown on evm runtime with ${syntheticEvent} for approve event`, async () => {
                const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, approveTx, approvalTopic);
                expect(rpcResult.length).to.equal(0, 'Transactions found when none was expected');
            });
        }
    });

    describe('Pointer deployment and interactions', () => {
        it('Alice deploys a pointer for cw20 contract', async () => {
            const pointer = await cw20Contract.deployPointer(TestConfig.evmRpcEndpoint);
            pointerContractAddress = await cw20Contract.queryPointerAddress();
            expect(pointerContractAddress).to.not.be.empty;
            pointerContract = new ethers.Contract(pointerContractAddress, pointerAbi.abi, alice.evmWallet.wallet) as unknown as CW20ERC20Pointer;
        });

        it('Alice cant deploy another pointer for the same cw20 contract address', async () => {
            try {
                await cw20Contract.deployPointer(TestConfig.evmRpcEndpoint);
                throw new Error('Should have failed');
            } catch (e: any) {
                expect(e.message).to.include('Pointer already deployed for this address');
            }
            const checkPointerAddress = await cw20Contract.queryPointerAddress();
            expect(checkPointerAddress).to.equal(pointerContractAddress);
        });

        // Check that no synthetic events are thrown for transactions before pointer deployment
        for (const syntheticEvent of rpcCalls) {
            it(`After deploying pointer, Alice won't see any synthetic events thrown on evm runtime for the txs pre pointer with ${syntheticEvent} for mint event`, async () => {
                const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, mintTx, topic);
                expect(rpcResult.length).to.equal(0, 'Transactions found when none was expected');
            });

            it(`After deploying pointer, Alice won't see any synthetic events thrown on evm runtime for the txs pre pointer with ${syntheticEvent} for burn event`, async () => {
                const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, burnTx, topic);
                expect(rpcResult.length).to.equal(0, 'Transactions found when none was expected');
            });
        }
    });

    describe('Operations after pointer deployment', () => {
        let postPointerMintTx: ExecuteResult;
        let postPointerTransferTx: ExecuteResult;
        let evmTransferTx: any;

        it('Alice can mint tokens after pointer deployment', async () => {
            const alicePreBalance = await cw20Contract.balanceOf(alice.seiAddress);
            postPointerMintTx = await cw20Contract.mint(alice.seiAddress, '200000');
            const alicePostBalance = await cw20Contract.balanceOf(alice.seiAddress);
            expect(Number(alicePostBalance)).to.equal(Number(alicePreBalance) + 200000);
        });

        it('Alice can transfer tokens to eve after pointer deployment', async () => {
            const evePreBalance = await cw20Contract.balanceOf(eve.seiAddress);
            const transferAmount = '100000';
            postPointerTransferTx = await cw20Contract.transfer(eve.seiAddress, transferAmount);
            const evePostBalance = await cw20Contract.balanceOf(eve.seiAddress);
            expect(Number(evePostBalance)).to.equal(Number(evePreBalance) + Number(transferAmount));
        });

        it('EVM pointer contract reflects the correct balances', async () => {
            const aliceEvmBalance = await pointerContract.balanceOf(alice.evmAddress);
            const eveEvmBalance = await pointerContract.balanceOf(eve.evmAddress);

            const aliceCwBalance = await cw20Contract.balanceOf(alice.seiAddress);
            const eveCwBalance = await cw20Contract.balanceOf(eve.seiAddress);

            expect(aliceEvmBalance.toString()).to.equal(aliceCwBalance);
            expect(eveEvmBalance.toString()).to.equal(eveCwBalance);
        });

        it('Alice can transfer tokens through EVM pointer contract', async () => {
            const bobPreBalance = await cw20Contract.balanceOf(bob.seiAddress);
            const transferAmount = ethers.parseUnits('50000', 0);

            evmTransferTx = await pointerContract.connect(alice.evmWallet.wallet).transfer(bob.evmAddress, transferAmount);
            await evmTransferTx.wait();

            const bobPostBalance = await cw20Contract.balanceOf(bob.seiAddress);
            expect(Number(bobPostBalance)).to.equal(Number(bobPreBalance) + 50000);
        });

        // Check for synthetic events after pointer deployment
        for (const syntheticEvent of rpcCalls) {
            it(`After pointer deployment, ${syntheticEvent} will return events for post-pointer transactions`, async () => {
                const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, postPointerTransferTx, topic);
                if (syntheticEvent.includes('Logs')) {
                    expect(rpcResult.length).to.be.gt(0, 'No transactions found when some were expected');
                    if (rpcResult.length > 0) {
                        expect(rpcResult[0].address.toLowerCase()).to.equal(pointerContractAddress.toLowerCase());
                        expect(rpcResult[0].topics[0].toLowerCase()).to.equal(topic.toLowerCase());
                    }
                }
            });
        }

        it('EVM transfer events can be queried', async () => {
            const txReceipt = await evmTransferTx.wait();
            expect(txReceipt.status).to.equal(1);

            const evmLogs = await rpcClient.eth_getLogs({
                fromBlock: ethers.toQuantity(txReceipt.blockNumber),
                toBlock: ethers.toQuantity(txReceipt.blockNumber),
                address: pointerContractAddress
            });

            expect(evmLogs.length).to.be.gt(0);
            expect(evmLogs[0].topics[0]).to.equal(topic);
        });
    });
});

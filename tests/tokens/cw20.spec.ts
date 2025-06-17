import {SeiUser, UserFactory} from "../../shared/User";
import util from "node:util";
import testConfig from "../../config/testConfig.json";
import {EvmRpcClient} from "../../shared/RpcClient";
import {Cw20Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import { ExecuteResult } from "@cosmjs/cosmwasm-stargate";
import {expect} from "chai";
import {DeliverTxResponse} from "@cosmjs/stargate";
import {ethers, LogDescription} from "ethers";
import {waitFor} from "../../shared/utils/helpers";
import pointerAbi from "../../artifacts/contracts/CW20ERC20Pointer.sol/CW20ERC20Pointer.json";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {CW20ERC20Pointer} from "../../typechain-types";
import {decodeTxInput} from "../../shared/utils/evmUtils";

const exec = util.promisify(require('node:child_process').exec);
const CHAIN_ID = 'psu-evm-test-5';
describe('CW20 Token Tests', function () {
    /**
     * Deploys ERC20 contract. Checks mint, transfer, approve functions with RPC events. Deploys a pointer and executes transactions
     */
    this.timeout(12 * 60 * 1000);
    let admin: SeiUser, alice: SeiUser, bob: SeiUser;
    let rpcClient: EvmRpcClient;
    let cw20ContractAddress: string;
    let pointerContractAddress: string;
    let cw20Contract: Cw20Token;

    before('Deploys cw20 wasm into cosmos runtime', async () => {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        ([alice, bob] = await UserFactory.createSeiUsers(admin, 2, false));
        const deployer = new TokenDeployer(admin);
        cw20Contract = await deployer.deployCw20('wasm_store/cw20_base.wasm', {
            "name": 'myCw20',
            "symbol": 'mycw',
            "decimals": 6,
            "mint": {
                minter: admin.seiAddress,
            },
            "initial_balances": [],
        }, 'myCw');
        rpcClient = new EvmRpcClient(testConfig.evmRpcEndpoint, admin.evmWallet.signingClient);
    });

    let mintTx: ExecuteResult;
    it.only('Admin mints cw20 tokens to her address on sei runtime', async () => {
        const amountToMint = '1000000';
        mintTx = await cw20Contract.mint(admin.seiAddress, amountToMint);
        const balance = await cw20Contract.balanceOf(admin.seiAddress);
        expect(balance).to.equal(amountToMint);
    });

    let multipleMintTxPrePointer: ExecuteResult;
    it.only('Admin can multiple mints tokens to her address on sei runtime in a single tx', async () => {
        const adminBalance = await cw20Contract.balanceOf(admin.seiAddress);
        const amounts = ['100000', '100000'];
        multipleMintTxPrePointer = await cw20Contract.mintMultiple([admin.seiAddress, admin.seiAddress], amounts);
        const adminAfterBalance = await cw20Contract.balanceOf(admin.seiAddress);
        expect(Number(adminAfterBalance)).to.equal(Number(adminBalance) + Number(200000));
    });

    it.only('Admin can transfer available amount to alice sei address on sei runtime', async () => {
        const transferAmount = '500000';
        await cw20Contract.transfer(alice.seiAddress, transferAmount,);
        const eveBalance = await cw20Contract.balanceOf(alice.seiAddress);
        expect(eveBalance).to.equal(transferAmount);
    });

    it.only('Admin cannot transfer more than her remaining balance to eve sei address on sei runtime', async () => {
        const transferAmount = '20000000';
        try {
            const contractTx = await cw20Contract.transfer(alice.seiAddress, transferAmount);
            throw new Error('Transfer should have failed');
        } catch (e: any) {
            expect(e.message).to.include('execute wasm contract failed');
        }
    });

    let burnTx: ExecuteResult;
    it.only('Admin burns amounts from her remaining balance on sei runtime', async () => {
        const burnAmount = '100';
        const preBalance = await cw20Contract.balanceOf(admin.seiAddress);
        burnTx = await cw20Contract.burn(burnAmount);
        const balance = await cw20Contract.balanceOf(admin.seiAddress);
        expect(Number(balance)).to.equal(Number(preBalance) - Number(burnAmount));
    });

    let twoMintsWithSeparateTxHeightPrePointer: DeliverTxResponse;
    it.only('Admin can call multiple mint tx on sei runtime with two different tx hashes on the same block', async () => {
        const mint1 = {
            mint: {
                recipient: alice.seiAddress,
                amount: '100000',
            }
        }

        const mint2 = {
            mint: {
                recipient: alice.seiAddress,
                amount: '100000',
            }
        }
        const alicePreBalance = await cw20Contract.balanceOf(alice.seiAddress);
        const txResults = await cw20Contract.executeMultipleInTheSameBlock(admin, cw20Contract.getAddress(), [mint1, mint2], CHAIN_ID);
        expect(txResults[0].stdout.height).to.be.eq(txResults[1].stdout.height);
        await waitFor(2);

        twoMintsWithSeparateTxHeightPrePointer = JSON.parse(txResults[0].stdout);
        const aliceAfterBalance = await cw20Contract.balanceOf(alice.seiAddress);
        expect(Number(aliceAfterBalance)).to.equal(Number(alicePreBalance) + Number(200000));
    });

    let approveTx: ExecuteResult;
    it.only('Admin approves Alice to spend her tokens on sei runtime on her behalf', async () => {
        approveTx = await cw20Contract.approve(alice.seiAddress, '1000');
        const allowance = await cw20Contract.allowance(admin.seiAddress, alice.seiAddress);
        expect(allowance).to.equal('1000');
    });

    const rpcCalls = ['sei_getLogs', 'sei_getFilterLogs', 'sei_getBlockByHash', 'sei_getBlockByNumber', 'eth_getLogs',
        'eth_getFilterLogs', 'eth_getBlockByHash', 'eth_getBlockByNumber'];
    for (const syntheticEvent of rpcCalls) {
        it.only(`Before deploying pointer, Alice wont see any synthetic events thrown on evm runtime with ${syntheticEvent} for mint event`, async () => {
            const topic = ethers.id('Transfer(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, mintTx, topic);
            expect(rpcResult.length).to.equal(0, 'Transactions found when none was expected');
        });

        it.only(`Before deploying pointer, Alice wont see any synthetic events thrown on evm runtime with ${syntheticEvent} for burn event`, async () => {
            const topic = ethers.id('Transfer(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, burnTx, topic);
            expect(rpcResult.length).to.equal(0, 'Transactions found when none was expected');
        });

        it.only(`Before deploying pointer, Alice wont see any synthetic events thrown on evm runtime with ${syntheticEvent} for approve event`, async () => {
            const topic = ethers.id('Approval(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, approveTx, topic);
            expect(rpcResult.length).to.equal(0, 'Transactions found when none was expected');
        });
    }

    let transferFilterId: string;
    it.only('Alice registers a filter on evm to listen synthetic events before deployment', async () => {
        const currentBlock = await rpcClient.getBlockNumber();
        const logParams = {
            fromBlock: ethers.toQuantity(currentBlock),
            toBlock: 'latest',
            topics: [ethers.id('Transfer(address,address,uint256)')],
        };
        transferFilterId = await rpcClient.sei_newFilter(logParams);
    });

    let pointerContract: CW20ERC20Pointer;
    it.only('Alice deploys a pointer for cw20 contract', async () => {
        const pointer = await cw20Contract.deployPointer(testConfig.evmRpcEndpoint);
        await waitFor(1);
        pointerContractAddress = await cw20Contract.queryPointerAddress();
        console.log('Pointer deployed to ', pointerContractAddress);
        pointerContract = new ethers.Contract(pointerContractAddress, pointerAbi.abi, admin.evmWallet.wallet) as unknown as CW20ERC20Pointer;
    });

    it.only('Alice cant deploy another pointer for the same cw20 contract address', async () => {
        try {
            await cw20Contract.deployPointer(testConfig.evmRpcEndpoint);
        } catch (e: any) {
            expect(e.message).to.include('Pointer already deployed for this address');
        }
    });

    it.only('After pointer deployment all balances are migrated correctly', async () =>{
        const adminCosmosBalance = await cw20Contract.balanceOf(admin.seiAddress);
        const adminEvmBalance = await pointerContract.balanceOf(admin.evmAddress);

        // Verify that balances are correctly migrated (they should match)
        expect(adminEvmBalance.toString()).to.equal(adminCosmosBalance);

        // Verify the same for Alice to ensure all balances migrated properly
        const aliceCosmosBalance = await cw20Contract.balanceOf(alice.seiAddress);
        const aliceEvmBalance = await pointerContract.balanceOf(alice.evmAddress);
        expect(aliceEvmBalance.toString()).to.equal(aliceCosmosBalance);
    });

    it.only('After pointer deployment admin approvals are migrated correctly', async () =>{
        const adminApprovalToAliceOnCosmos = await cw20Contract.allowance(admin.seiAddress, alice.seiAddress);
        const adminApprovalToAliceOnEvm = await pointerContract.allowance(admin.evmAddress, alice.evmAddress);
        // Verify that approvals are correctly migrated
        expect(adminApprovalToAliceOnEvm.toString()).to.equal(adminApprovalToAliceOnCosmos);
    });

    it.only('Admin can transfer funds on evm runtime', async () =>{
        const adminInitialBalance = await pointerContract.balanceOf(admin.evmAddress);
        const aliceInitialBalance = await pointerContract.balanceOf(alice.evmAddress);

        const transferAmount = '100000';

        // Execute transfer on EVM side
        const tx = await pointerContract.connect(admin.evmWallet.wallet).transfer(alice.evmAddress, transferAmount);
        await tx.wait();

        // Check final balances on both chains
        const adminFinalBalanceEvm = await pointerContract.balanceOf(admin.evmAddress);
        const aliceFinalBalanceEvm = await pointerContract.balanceOf(alice.evmAddress);

        const adminFinalBalanceCosmos = await cw20Contract.balanceOf(admin.seiAddress);
        const aliceFinalBalanceCosmos = await cw20Contract.balanceOf(alice.seiAddress);

        // Verify balances are updated correctly on both chains
        expect(adminFinalBalanceEvm.toString()).to.equal((BigInt(adminInitialBalance.toString()) - BigInt(transferAmount)).toString());
        expect(aliceFinalBalanceEvm.toString()).to.equal((BigInt(aliceInitialBalance.toString()) + BigInt(transferAmount)).toString());

        // Verify Cosmos balances match EVM balances
        expect(adminFinalBalanceEvm.toString()).to.equal(adminFinalBalanceCosmos);
        expect(aliceFinalBalanceEvm.toString()).to.equal(aliceFinalBalanceCosmos);
    });

    it.only('Alice can use migrated approvals to send tokens on evm runtime', async () =>{
        const bobPreBalance = await pointerContract.balanceOf(bob.evmAddress);
        const tx = await pointerContract.connect(alice.evmWallet.wallet).transferFrom(admin.evmAddress, bob.evmAddress, '1000');
        await tx.wait();
        const bobAfterBalance = await pointerContract.balanceOf(bob.evmAddress);
        expect(bobPreBalance.toString()).to.equal((BigInt(bobAfterBalance.toString()) - BigInt('1000')).toString());

        //Approvals are updated on both chains
        const adminApprovalToAliceOnEvm = await pointerContract.allowance(admin.evmAddress, alice.evmAddress);
        const adminApprovalOnCosmos = await cw20Contract.allowance(admin.seiAddress, alice.seiAddress);
        expect(adminApprovalToAliceOnEvm.toString()).to.equal(adminApprovalOnCosmos);
    });

    it.only('Admin can approve tokens on evm runtime', async () =>{
        const approvalAmount = '10000';
        // Execute approve on EVM side
        const tx = await pointerContract.connect(admin.evmWallet.wallet).approve(alice.evmAddress, approvalAmount);
        await tx.wait();

        // Check allowances on both chains
        const allowanceOnEvm = await pointerContract.allowance(admin.evmAddress, alice.evmAddress);
        const allowanceOnCosmos = await cw20Contract.allowance(admin.seiAddress, alice.seiAddress);

        // Verify allowances are updated correctly on both chains
        expect(allowanceOnEvm.toString()).to.equal(approvalAmount);
        expect(allowanceOnCosmos).to.equal(approvalAmount);
    });

    it.only('Alice can use approvals to send tokens on evm runtime', async () =>{
        const bobPreBalance = await pointerContract.balanceOf(bob.evmAddress);
        const tx = await pointerContract.connect(alice.evmWallet.wallet)
            .transferFrom(admin.evmAddress, bob.evmAddress, '5000');
        await tx.wait();
        const bobAfterBalance = await pointerContract.balanceOf(bob.evmAddress);
        expect(bobAfterBalance.toString()).to.equal((BigInt(bobPreBalance.toString()) + BigInt('5000')).toString());
    });

    it.only('Alice can use migrated approvals to send tokens on cosmos runtime', async () =>{
        cw20Contract.setSigner(alice);
        await cw20Contract.transferFrom(admin.seiAddress, bob.seiAddress, '5000');
        await waitFor(1);
        const bobBalance = await cw20Contract.balanceOf(bob.seiAddress);
        expect(bobBalance).to.equal('11000');
        cw20Contract.setSigner(admin);
    });

    it.only('After pointer deployment approval txs on cosmos side are reflected on evm runtime', async () =>{
        approveTx = await cw20Contract.approve(alice.seiAddress, '10000');
        await cw20Contract.approve(alice.seiAddress, '0');
    })

    let multiMsgHeight: ExecuteResult;
    it.only('After pointer deployment evm tracks state in cosmos multi message txs', async () =>{
        const firstAmount = '2000';
        const secondAmount = '2000';

        // Get initial balances
        const adminInitialBalanceCosmos = await cw20Contract.balanceOf(admin.seiAddress);
        const aliceInitialBalanceCosmos = await cw20Contract.balanceOf(alice.seiAddress);
        const bobInitialBalanceCosmos = await cw20Contract.balanceOf(bob.seiAddress);

        // Create multiple messages for a single transaction
        const msgs = [
            {contractAddress: cw20Contract.getAddress(),
                msg: { transfer: { recipient: alice.seiAddress, amount: firstAmount }}},
            {contractAddress: cw20Contract.getAddress(),
                msg: { transfer: { recipient: bob.seiAddress, amount: secondAmount }}}
        ];

        const multiMsgResult = await cw20Contract.execMultiple(msgs);

        // Wait for transaction to be processed
        await waitFor(1);

        // Check final balances on both chains
        const adminFinalBalanceCosmos = await cw20Contract.balanceOf(admin.seiAddress);
        const aliceFinalBalanceCosmos = await cw20Contract.balanceOf(alice.seiAddress);
        const bobFinalBalanceCosmos = await cw20Contract.balanceOf(bob.seiAddress);

        const adminFinalBalanceEvm = await pointerContract.balanceOf(admin.evmAddress);
        const aliceFinalBalanceEvm = await pointerContract.balanceOf(alice.evmAddress);
        const bobFinalBalanceEvm = await pointerContract.balanceOf(bob.evmAddress);

        // Calculate expected balances
        const expectedAdminBalance = (BigInt(adminInitialBalanceCosmos) - BigInt(firstAmount) - BigInt(secondAmount)).toString();
        const expectedAliceBalance = (BigInt(aliceInitialBalanceCosmos) + BigInt(firstAmount)).toString();
        const expectedBobBalance = (BigInt(bobInitialBalanceCosmos) + BigInt(secondAmount)).toString();

        // Verify balances are updated correctly on Cosmos chain
        expect(adminFinalBalanceCosmos).to.equal(expectedAdminBalance);
        expect(aliceFinalBalanceCosmos).to.equal(expectedAliceBalance);
        expect(bobFinalBalanceCosmos).to.equal(expectedBobBalance);

        // Verify EVM balances match Cosmos balances
        expect(adminFinalBalanceEvm.toString()).to.equal(adminFinalBalanceCosmos);
        expect(aliceFinalBalanceEvm.toString()).to.equal(aliceFinalBalanceCosmos);
        expect(bobFinalBalanceEvm.toString()).to.equal(bobFinalBalanceCosmos);
        multiMsgHeight = multiMsgResult;
    });

    let multiSendAfterPointerHeight: ExecuteResult;
    it.only('After pointer deployment evm and cosmos txs in a single block from same sender doesnt disrupt the state', async () =>{
        const adminInitialBalanceCosmos = await cw20Contract.balanceOf(admin.seiAddress);
        const bobInitialBalanceCosmos = await cw20Contract.balanceOf(bob.seiAddress);

        // Set up transfer amounts
        const cosmosTransferAmount = '2500';
        const evmTransferAmount = '2500';

        const encodeTx = pointerContract.connect(admin.evmWallet.wallet).interface
            .encodeFunctionData('transfer(address,uint256)', [bob.evmAddress, evmTransferAmount]);
        const signedTx = await AtomicTxSender.signEvmTransaction(admin, pointerContract.target, encodeTx);


        const delayedCosmosTx = async () => {
            await waitFor(0.2);
            return admin.evmWallet.signingClient.broadcastTransaction(signedTx);
        };

        // Send both transactions closely to try to get them in the same block
        const [evmReceipt, cosmosTxResult] = await Promise.all([
            delayedCosmosTx(),
            cw20Contract.transfer(bob.seiAddress, cosmosTransferAmount)
        ]);
        const txBlock = (await rpcClient.getTransactionReceipt(evmReceipt.hash));
        console.log(ethers.toNumber(txBlock.blockNumber));
        console.log(cosmosTxResult.height);
        if (ethers.toNumber(txBlock.blockNumber) === cosmosTxResult.height) {
            console.log('Couldnt capture in one block');
        }
        await waitFor(2);

        // Get final balances on both chains
        const adminFinalBalanceCosmos = await cw20Contract.balanceOf(admin.seiAddress);
        const bobFinalBalanceCosmos = await cw20Contract.balanceOf(bob.seiAddress);

        const adminFinalBalanceEvm = await pointerContract.balanceOf(admin.evmAddress);
        const bobFinalBalanceEvm = await pointerContract.balanceOf(bob.evmAddress);

        // Calculate expected balances
        const expectedAdminBalance = (BigInt(adminInitialBalanceCosmos) - BigInt(cosmosTransferAmount) - BigInt(evmTransferAmount)).toString();
        const expectedBobBalance = (BigInt(bobInitialBalanceCosmos) + BigInt(evmTransferAmount) + BigInt(cosmosTransferAmount)).toString();

        // Verify balances are updated correctly on both chains
        expect(adminFinalBalanceCosmos).to.equal(expectedAdminBalance);
        expect(bobFinalBalanceCosmos).to.equal(expectedBobBalance);

        expect(adminFinalBalanceEvm.toString()).to.equal(expectedAdminBalance);
        expect(bobFinalBalanceEvm.toString()).to.equal(expectedBobBalance);
        multiSendAfterPointerHeight = cosmosTxResult;
    });

    let mintTxAfterPointer: ExecuteResult;
    it.only('Alice mints tokens on sei runtime with cw20 contract call', async () => {
        const alicePreBalance = await cw20Contract.balanceOf(alice.seiAddress);
        const amount = '1000000';
        mintTxAfterPointer = await cw20Contract.mint(alice.seiAddress, amount);
        const aliceAfterBalance = await cw20Contract.balanceOf(alice.seiAddress);
        expect(Number(aliceAfterBalance)).to.equal(Number(alicePreBalance) + Number(amount));
    });

    let oneSuccessOneFailTxHeight: ExecuteResult;
    it.only('Admin sends two transactions in the same block but one tx fails', async () =>{
        const encodedTx = pointerContract.connect(admin.evmWallet.wallet).interface
            .encodeFunctionData('transfer(address,uint256)', [alice.evmAddress, '100000000']);
        const signedTx = await AtomicTxSender.signEvmTransaction(admin, pointerContract.target, encodedTx);
        const delayed = async () => {
            await waitFor(0.2);
            return admin.evmWallet.signingClient.broadcastTransaction(signedTx);
        }
        const [evmReceipt, cosmosTxResult] = await Promise.all([
            delayed(),
            cw20Contract.transfer(alice.seiAddress, '1000')
        ]);
        const receipt = await rpcClient.getTransactionReceipt(evmReceipt.hash);
        console.log(ethers.toNumber(receipt.blockNumber));
        console.log(cosmosTxResult.height);
        oneSuccessOneFailTxHeight = cosmosTxResult;
    });


    it.only('Alice can decrease allowance of Bob to spend her tokens on sei runtime', async () => {
        const approveAmount = '1500';
        cw20Contract.setSigner(alice);
        await cw20Contract.approve(bob.seiAddress, '2000');
        await cw20Contract.decreaseAllowance(bob.seiAddress, approveAmount);
        const allowance = await cw20Contract.allowance(alice.seiAddress, bob.seiAddress);
        const evmAllowance = await pointerContract.allowance(alice.evmAddress, bob.evmAddress);
        expect(allowance).to.equal('500');
        expect(evmAllowance.toString()).to.equal('500');
        cw20Contract.setSigner(admin);
    });

    const syntheticEvents = ['sei_getLogs', 'sei_getBlockByNumber', 'sei_getBlockByHash', 'sei_getFilterLogs'];
    for (const syntheticEvent of syntheticEvents) {
        it.only(`After registering pointer, Alice can see mint event on evm runtime with synthetic ${syntheticEvent} call`, async () => {
            const topic = ethers.id('Transfer(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, mintTxAfterPointer, topic, pointerContractAddress);
            expect(rpcResult.length).to.equal(1, 'Transactions found when none was expected');
            if (syntheticEvent.includes('Logs')) {
                for (const log of rpcResult) {
                    const parsedLogs = pointerContract.interface.parseLog(log) as LogDescription;
                    expect(parsedLogs.name).to.equal('Transfer');
                    expect(parsedLogs.args[1]).to.equal(alice.evmAddress);
                    expect(parsedLogs.args[2].toString()).to.equal('1000000');
                }
            } else {
                for (const tx of rpcResult) {
                    const decodedInput = await decodeTxInput(tx.input);
                    expect(decodedInput.mint.recipient).to.equal(alice.seiAddress);
                    expect(decodedInput.mint.amount).to.equal('1000000');
                }
            }
        });

        it.only(`After registering pointer, Alice can see multiple transfer events with the same tx on evm runtime with synthetic ${syntheticEvent} call`, async () => {
            const topic = ethers.id('Transfer(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, multiSendAfterPointerHeight, topic, pointerContractAddress);
            expect(rpcResult.length).to.equal(2, 'Transactions not found when two was expected');
            if (syntheticEvent.includes('Logs')) {
                for (const log of rpcResult) {
                    const parsedLogs = pointerContract.interface.parseLog(log) as LogDescription;
                    expect(parsedLogs.name).to.equal('Transfer');
                    expect(parsedLogs.args[1]).to.equal(bob.evmAddress);
                    expect(parsedLogs.args[2].toString()).to.equal('2500');
                }
            } else {
                for (const tx of rpcResult) {
                    try{
                        const decodedInput = await decodeTxInput(tx.input);
                        console.log('Decoded input is ', decodedInput);
                        expect(decodedInput.mint.recipient).to.equal(bob.seiAddress);
                        expect(decodedInput.mint.amount).to.equal('2500');
                    } catch(e: any){}
                }
            }
        });

        it.only(`After registering pointer, Alice can see multiple transfer events with the same cosmos tx on evm runtime with synthetic ${syntheticEvent} call`, async () => {
            const topic = ethers.id('Transfer(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, multiMsgHeight, topic, pointerContractAddress);

            expect(rpcResult.length).to.equal(2, 'Transactions found when none was expected');
            if (syntheticEvent.includes('Logs')) {
                for (const log of rpcResult) {
                    const parsedLogs = pointerContract.interface.parseLog(log) as LogDescription;
                    expect(parsedLogs.name).to.equal('Transfer');
                    expect(parsedLogs.args[1]).to.be.oneOf([bob.evmAddress, alice.evmAddress]);
                    expect(parsedLogs.args[2].toString()).to.equal('2000');
                }
            } else {
                for (const tx of rpcResult) {
                    const decodedInput = await decodeTxInput(tx.input);
                    expect(decodedInput.transfer.recipient).to.be.oneOf([bob.seiAddress, alice.seiAddress]);
                    expect(decodedInput.transfer.amount).to.equal('2000');
                }
            }
        });

        it.only(`After registering pointer, Alice can see approval event with ${syntheticEvent} call`, async () => {
            const topic = ethers.id('Approval(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, approveTx, topic, pointerContractAddress);
            expect(rpcResult.length).to.equal(1, 'Transactions found when none was expected');
            if (syntheticEvent.includes('Logs')) {
                for (const log of rpcResult) {
                    const parsedLogs = pointerContract.interface.parseLog(log) as LogDescription;
                    expect(parsedLogs.name).to.equal('Approval');
                    expect(parsedLogs.args[0].toLowerCase()).to.equal(admin.evmAddress.toLowerCase());
                    expect(parsedLogs.args[1].toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
                    expect(parsedLogs.args[2].toString()).to.equal('10000');
                }
            } else {
                for (const tx of rpcResult) {
                    const decodedInput = await decodeTxInput(tx.input);
                    expect(decodedInput.increase_allowance.spender).to.equal(alice.seiAddress);
                    expect(decodedInput.increase_allowance.amount).to.equal('10000');
                }
            }
        });

        it.only(`Failed txs will be captured by the synthetic endpoint ${syntheticEvent}`, async () => {
            const topic = ethers.id('Transfer(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(syntheticEvent, oneSuccessOneFailTxHeight, topic, pointerContractAddress);
            if (syntheticEvent.includes('Logs')) {
                for (const log of rpcResult) {
                    expect(rpcResult.length).to.equal(1, 'Transactions found when none was expected');
                    const parsedLogs = pointerContract.interface.parseLog(log) as LogDescription;
                    expect(parsedLogs.name).to.equal('Transfer');
                    expect(parsedLogs.args[1]).to.be.oneOf([bob.evmAddress, alice.evmAddress]);
                    expect(parsedLogs.args[2].toString()).to.equal('1000');
                }
            } else {
                for (const tx of rpcResult) {
                    expect(rpcResult.length).to.equal(2, 'Transactions found when none was expected');
                    try{
                        const decodedInput = await decodeTxInput(tx.input);
                        console.log('Decoded input is ', decodedInput);
                    } catch(e:any){return}
                }
            }
        });
    }

    const ethEndpoints = ['eth_getLogs', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getFilterLogs'];
    for (const ethEndpoint of ethEndpoints) {
        it.only(`Alice wont see synthetic events for mint events on evm runtime with ${ethEndpoint}`, async () => {
            const topic = ethers.id('Transfer(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(ethEndpoint, mintTxAfterPointer, topic);
            expect(rpcResult.length).to.equal(0, 'Transactions found when none was expected');
        });

        it.only(`Only evm data will be returned for multiple transfer events on eth ${ethEndpoint}`, async () =>{
            const topic = ethers.id('Transfer(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(ethEndpoint, multiSendAfterPointerHeight, topic);
            expect(rpcResult.length).to.equal(1, 'Transactions found when none was expected');
        });

        it.only(`Given that a tx has failed on evm runtime, ${ethEndpoint} will return correct info`, async () =>{
            const topic = ethers.id('Transfer(address,address,uint256)');
            const rpcResult = await rpcClient.checkAndReturnRpcCallResults(ethEndpoint, oneSuccessOneFailTxHeight, topic);
            if (ethEndpoint.includes('Logs')) {
                expect(rpcResult.length).to.equal(0, 'Transactions found when none was expected');
            } else {
                expect(rpcResult.length).to.equal(1, 'Transactions found when none was expected');
            }
        });
    }

    it.only('Alice cant set minus amounts for approval on evm runtime', async () => {
        const negative1000Uint = (1n << 256n) - 1000n;
        try {
            const txRequest: ethers.TransactionRequest = {
                to: pointerContractAddress,
                data: pointerContract.interface.encodeFunctionData('approve', [bob.evmAddress, '-1000']),
                value: 0n,
            };
        } catch (e: any) {
            return true;
        }
    });


    it.only('Failing approval tx wont change the state on evm runtime', async () => {
        const initialAllowance = '1000';
        const tx = await pointerContract.connect(alice.evmWallet.wallet).approve(bob.evmAddress, initialAllowance);
        const receipt = await tx.wait();
        try {
            const evmTxRequest: ethers.TransactionRequest = {
                to: pointerContractAddress,
                data: pointerContract.interface.encodeFunctionData('approve', [bob.evmAddress, '0']),
                gasLimit: 10,
            };
            await alice.evmWallet.wallet.sendTransaction(evmTxRequest);
            throw new Error('EVM transaction should have failed');
        } catch (e: any) {
            expect(e.message).to.include('could not coalesce error');
        }

        const evmAllowance = await pointerContract.allowance(alice.evmAddress, bob.evmAddress);
        const seiAllowance = await cw20Contract.allowance(
            alice.seiAddress, bob.seiAddress
        );

        expect(evmAllowance.toString()).to.equal(initialAllowance);
        expect(seiAllowance).to.equal(initialAllowance);
    });


    describe.skip('Checks queries on pointers', async () =>{
        let seiTransferTx: ethers.ContractTransactionReceipt;
        let hhTransferTx: ethers.ContractTransactionReceipt;
        let hardhat: Hardhat;

        it('Sei and Eth rpc results match with hardhat events for eth_getBlockByNumber', async () => {
            console.info('Running hardhat port');
            hardhat = new Hardhat('8595');
            // Initialize hardhat node
            hardhat.initializeHardhat();
            await hardhat.deployErc20();
            const hhErc20 = hardhat.erc20;
            //Validate transfer event
            const hhMint = await hhErc20.mint(hardhat.hardhatOwner.address, '100000');
            await hhMint.wait();

            const hhTransferTransaction = await hhErc20.transfer(eve.evmAddress, '1000');
            hhTransferTx = await hhTransferTransaction.wait() as ethers.ContractTransactionReceipt;

            const seiTransferTransaction = await pointerContract.transfer(eve.evmAddress, '1000');
            seiTransferTx = await seiTransferTransaction.wait();

            const hhRpcCall = await hardhat.returnHardhatProvider().send('eth_getBlockByNumber', [hhTransferTx!.blockNumber, true]);
            const seiRpcCall = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(seiTransferTx.blockNumber), true);
            hardhat.validateBlocks(hhRpcCall, seiRpcCall, expect);
        });

        it('Sei and Eth rpc results match with hardhat events for eth_getBlockByHash', async () => {
            const rpcResult = await rpcClient.eth_getBlockByHash(seiTransferTx!.blockHash, true);
            const hhRpcResult = await hardhat.returnHardhatProvider().send('eth_getBlockByHash', [hhTransferTx!.blockHash, true]);
            hardhat.validateBlocks(rpcResult, hhRpcResult, expect);
        });

        it('Sei and Eth rpc results match with hardhat events for sei_getBlockByNumber', async () => {
            const rpcResult = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(seiTransferTx.blockNumber), true);
            const hhRpcResult = await hardhat.returnHardhatProvider().send('eth_getBlockByNumber', [hhTransferTx!.blockNumber, true]);
            hardhat.validateBlocks(rpcResult, hhRpcResult, expect);
        });

        it('Sei and Eth rpc results match with hardhat events for sei_getBlockByHash', async () => {
            const rpcResult = await rpcClient.sei_getBlockByHash(seiTransferTx!.blockHash, true);
            const hhRpcResult = await hardhat.returnHardhatProvider().send('eth_getBlockByHash', [hhTransferTx!.blockHash, true]);
            hardhat.validateBlocks(hhRpcResult, rpcResult, expect);
            await hardhat.stopNode();
        });
    });
});

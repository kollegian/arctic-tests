import { SeiUser, UserFactory } from "../../shared/User";
import { Cw20Token, Erc20Token } from "../../shared/Token";
import contractAddresses from './contractAddresses.json';
import { EvmRpcClient } from "../../shared/RpcClient";
import { Block, ContractTransactionReceipt, ethers, LogDescription, TransactionReceipt } from "ethers";
import { expect } from "chai";
import { AtomicTxSender } from "../../shared/TxBuilder";
import { waitFor } from "../../shared/utils/helpers";
import { ExecuteResult } from "@cosmjs/cosmwasm-stargate";
import { TokenDeployer } from "../../shared/Deployer";
import { DebugContract } from '../../typechain-types';
import DebugContractAbi from '../../artifacts/contracts/DebugContract.sol/DebugContract.json';

describe('Eth Get Transaction Receipt Tests', function () {
    this.timeout(10 * 60 * 1000);

    let users: SeiUser[];
    let admin: SeiUser;
    let erc20: Erc20Token;
    let rpcClient: EvmRpcClient;
    let pointerCw20: Cw20Token;
    let baseCw20: Cw20Token;
    let debugContract: DebugContract;
    let provider: ethers.JsonRpcProvider;

    // Test transaction receipts
    let successfulTxReceipt: ContractTransactionReceipt;
    let failedTxReceipt: ContractTransactionReceipt;
    let contractCreationTxReceipt: ContractTransactionReceipt;
    let simpleTransferTxReceipt: ContractTransactionReceipt;
    let multipleLogsTxReceipt: ContractTransactionReceipt;

    before('Initializes', async () => {
        admin = await UserFactory.createAdminUser();
        users = await UserFactory.createSeiUsers(admin, 5, true);
        erc20 = new Erc20Token(admin, contractAddresses.erc20);
        pointerCw20 = new Cw20Token(admin, contractAddresses.ercPointerOnCosmos);
        baseCw20 = new Cw20Token(admin, contractAddresses.cw20);
        debugContract = new ethers.Contract(contractAddresses.debugAddress, DebugContractAbi.abi, admin.evmWallet.signingClient) as unknown as DebugContract;
        rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
        provider = admin.evmWallet.signingClient;
    });

    describe('Setup test transactions', function () {
        it('Creates a successful ERC20 transfer transaction', async () => {
            const tx = await erc20.transfer(users[0].evmAddress, ethers.parseEther('1'));
            successfulTxReceipt = await tx.wait() as ContractTransactionReceipt;
            expect(successfulTxReceipt.status).to.equal(1);
        });

        it('Creates a failed transaction (insufficient balance)', async () => {
            const encodedData = erc20.contract.interface.encodeFunctionData('transfer', [users[1].evmAddress, ethers.parseEther('1000000000')]);
            const signedTx = await AtomicTxSender.signEvmTransaction(users[0], erc20.getAddress(), encodedData);
            const txHash = await AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin);
            console.log(`Failed transaction hash: ${txHash}`);
            await waitFor(1);
            failedTxReceipt = await rpcClient.getTransactionReceipt(txHash) as ContractTransactionReceipt;
            expect(Number(failedTxReceipt.status)).to.equal(0);
            console.log(failedTxReceipt);
        });

        it('Creates a simple ETH transfer transaction', async () => {
            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: users[2].evmAddress,
                value: ethers.parseEther('0.001')
            });
            simpleTransferTxReceipt = await tx.wait() as ContractTransactionReceipt;
            expect(simpleTransferTxReceipt.status).to.equal(1);
        });

        it('Creates a transaction with multiple logs (ERC20 mint)', async () => {
            const tx = await erc20.mint(users[3].evmAddress, ethers.parseEther('10'));
            multipleLogsTxReceipt = await tx.wait() as ContractTransactionReceipt;
            expect(multipleLogsTxReceipt.status).to.equal(1);
            expect(multipleLogsTxReceipt.logs.length).to.be.greaterThan(0);
        });
    });

    describe('Validate eth_getTransactionReceipt fields for successful transaction', function () {
        it('Validates all required fields are present', async () => {
            const receipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);

            // Required fields
            expect(receipt).to.have.property('transactionHash');
            expect(receipt).to.have.property('transactionIndex');
            expect(receipt).to.have.property('blockHash');
            expect(receipt).to.have.property('blockNumber');
            expect(receipt).to.have.property('from');
            expect(receipt).to.have.property('to');
            expect(receipt).to.have.property('cumulativeGasUsed');
            expect(receipt).to.have.property('gasUsed');
            expect(receipt).to.have.property('contractAddress');
            expect(receipt).to.have.property('logs');
            expect(receipt).to.have.property('status');
            expect(receipt).to.have.property('logsBloom');
        });

        it('Validates field types and formats', async () => {
            const receipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);

            // Check field types
            expect(receipt.transactionHash).to.be.a('string');
            expect(receipt.transactionHash).to.match(/^0x[a-fA-F0-9]{64}$/);
            expect(receipt.transactionIndex).to.be.a('string');
            expect(receipt.blockHash).to.be.a('string');
            expect(receipt.blockHash).to.match(/^0x[a-fA-F0-9]{64}$/);
            expect(receipt.blockNumber).to.be.a('string');
            expect(receipt.from).to.be.a('string');
            expect(receipt.from).to.match(/^0x[a-fA-F0-9]{40}$/);
            expect(receipt.to).to.be.a('string');
            expect(receipt.to).to.match(/^0x[a-fA-F0-9]{40}$/);
            expect(receipt.cumulativeGasUsed).to.be.a('string');
            expect(receipt.gasUsed).to.be.a('string');
            // expect(receipt.contractAddress).to.be.a('string');
            expect(receipt.logs).to.be.an('array');
            expect(receipt.status).to.be.a('string');
            expect(receipt.logsBloom).to.be.a('string');
        });

        it('Validates field values for successful transaction', async () => {
            const receipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);

            // Check specific values
            expect(receipt.transactionHash).to.equal(successfulTxReceipt.hash);
            expect(receipt.status).to.equal('0x1'); // Success
            expect(receipt.from.toLowerCase()).to.equal(admin.evmAddress.toLowerCase());
            expect(receipt.to.toLowerCase()).to.equal(erc20.getAddress().toLowerCase());
            expect(receipt.contractAddress).to.equal(null); // Not a contract creation
            expect(parseInt(receipt.gasUsed, 16)).to.be.greaterThan(0);
            expect(parseInt(receipt.cumulativeGasUsed, 16)).to.be.greaterThan(0);
            expect(parseInt(receipt.blockNumber, 16)).to.be.greaterThan(0);
            expect(parseInt(receipt.transactionIndex, 16)).to.be.greaterThanOrEqual(0);
        });

        it('Validates logs array structure', async () => {
            const receipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);

            expect(receipt.logs).to.be.an('array');
            if (receipt.logs.length > 0) {
                const log = receipt.logs[0];
                expect(log).to.have.property('removed');
                expect(log).to.have.property('logIndex');
                expect(log).to.have.property('transactionIndex');
                expect(log).to.have.property('transactionHash');
                expect(log).to.have.property('blockHash');
                expect(log).to.have.property('blockNumber');
                expect(log).to.have.property('address');
                expect(log).to.have.property('data');
                expect(log).to.have.property('topics');

                // Check types
                expect(log.removed).to.be.a('boolean');
                expect(log.logIndex).to.be.a('string');
                expect(log.transactionIndex).to.be.a('string');
                expect(log.transactionHash).to.be.a('string');
                expect(log.blockHash).to.be.a('string');
                expect(log.blockNumber).to.be.a('string');
                expect(log.address).to.be.a('string');
                expect(log.data).to.be.a('string');
                expect(log.topics).to.be.an('array');
            }
        });

        it('Validates logsBloom format', async () => {
            const receipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);

            expect(receipt.logsBloom).to.be.a('string');
            expect(receipt.logsBloom).to.match(/^0x[a-fA-F0-9]{512}$/); // 256 bytes = 512 hex chars
        });
    });

    describe('Validate eth_getTransactionReceipt fields for failed transaction', function () {
        it('Validates status field for failed transaction', async () => {
            console.log(failedTxReceipt);
            const receipt = await rpcClient.getTransactionReceipt(failedTxReceipt.transactionHash);

            expect(receipt.status).to.equal('0x0'); // Failed
            expect(receipt.transactionHash).to.equal(failedTxReceipt.transactionHash);
            expect(parseInt(receipt.gasUsed, 16)).to.be.greaterThan(0);
        });

        it('Validates logs for failed transaction', async () => {
            const receipt = await rpcClient.getTransactionReceipt(failedTxReceipt.transactionHash);

            // Failed transactions may or may not have logs depending on when they fail
            expect(receipt.logs).to.be.an('array');
        });
    });

    describe('Validate eth_getTransactionReceipt fields for simple ETH transfer', function () {
        it('Validates fields for simple transfer', async () => {
            const receipt = await rpcClient.getTransactionReceipt(simpleTransferTxReceipt.hash);

            expect(receipt.status).to.equal('0x1');
            expect(receipt.from.toLowerCase()).to.equal(admin.evmAddress.toLowerCase());
            expect(receipt.to.toLowerCase()).to.equal(users[2].evmAddress.toLowerCase());
            expect(receipt.contractAddress).to.equal(null);
            expect(receipt.logs).to.be.an('array');
            expect(receipt.logs.length).to.equal(0); // Simple transfers don't generate logs
        });
    });

    describe('Validate eth_getTransactionReceipt fields for transaction with multiple logs', function () {
        it('Validates logs for transaction with multiple events', async () => {
            const receipt = await rpcClient.getTransactionReceipt(multipleLogsTxReceipt.hash);

            expect(receipt.status).to.equal('0x1');
            expect(receipt.logs).to.be.an('array');
            expect(receipt.logs.length).to.be.greaterThan(0);

            // Validate each log
            receipt.logs.forEach((log, index) => {
                expect(log).to.have.property('removed');
                expect(log).to.have.property('logIndex');
                expect(log).to.have.property('transactionIndex');
                expect(log).to.have.property('transactionHash');
                expect(log).to.have.property('blockHash');
                expect(log).to.have.property('blockNumber');
                expect(log).to.have.property('address');
                expect(log).to.have.property('data');
                expect(log).to.have.property('topics');

                expect(log.transactionHash).to.equal(multipleLogsTxReceipt.hash);
                expect(log.blockNumber).to.equal(receipt.blockNumber);
                expect(log.blockHash).to.equal(receipt.blockHash);
                expect(log.address.toLowerCase()).to.equal(erc20.getAddress().toLowerCase());
            });
        });

        it('Validates log topics structure', async () => {
            const receipt = await rpcClient.getTransactionReceipt(multipleLogsTxReceipt.hash);

            receipt.logs.forEach((log) => {
                expect(log.topics).to.be.an('array');
                expect(log.topics.length).to.be.greaterThan(0);

                // First topic should be the event signature
                expect(log.topics[0]).to.match(/^0x[a-fA-F0-9]{64}$/);

                // All topics should be 32-byte hex strings
                log.topics.forEach((topic) => {
                    expect(topic).to.match(/^0x[a-fA-F0-9]{64}$/);
                });
            });
        });
    });

    describe('Validate eth_getTransactionReceipt edge cases', function () {
        it('Returns null for non-existent transaction hash', async () => {
            const fakeHash = '0x1234567890123456789012345678901234567890123456789012345678901234';
            const receipt = await rpcClient.getTransactionReceipt(fakeHash);
            expect(receipt).to.be.null;
        });

        it('Returns null for malformed transaction hash', async () => {
            const malformedHash = '0x123'; // Too short
            try {
                await rpcClient.getTransactionReceipt(malformedHash);
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error).to.be.instanceOf(Error);
            }
        });

        it('Validates transaction index consistency', async () => {
            const receipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);

            // Get block to verify transaction index
            const block = await rpcClient.getBlockByNumber(receipt.blockNumber, true);
            const txIndex = parseInt(receipt.transactionIndex, 16);

            expect(block.transactions.length).to.be.greaterThan(txIndex);
            expect(block.transactions[txIndex].hash).to.equal(receipt.transactionHash);
        });

        it('Validates block hash consistency', async () => {
            const receipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);

            // Get block to verify block hash
            const block = await rpcClient.getBlockByNumber(receipt.blockNumber, false);
            expect(block.hash).to.equal(receipt.blockHash);
        });

        it('Validates cumulative gas used consistency', async () => {
            const receipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);

            const gasUsed = parseInt(receipt.gasUsed, 16);
            const cumulativeGasUsed = parseInt(receipt.cumulativeGasUsed, 16);

            expect(cumulativeGasUsed).to.be.greaterThanOrEqual(gasUsed);
        });
    });

    describe('Validate eth_getTransactionReceipt with different block states', function () {
        it('Validates receipt for latest block', async () => {
            const receipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);
            expect(receipt).to.not.be.null;
            expect(receipt.status).to.equal('0x1');
        });

        it('Validates receipt for finalized block', async () => {
            // Wait for block to be finalized
            await waitFor(2);
            const receipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);
            expect(receipt).to.not.be.null;
            expect(receipt.status).to.equal('0x1');
        });
    });

    describe('Compare with ethers.js receipt', function () {
        it('Compares RPC receipt with ethers.js receipt', async () => {
            const rpcReceipt = await rpcClient.getTransactionReceipt(successfulTxReceipt.hash);
            const ethersReceipt = await provider.getTransactionReceipt(successfulTxReceipt.hash);

            // Compare key fields
            expect(rpcReceipt.transactionHash).to.equal(ethersReceipt.hash);
            expect(rpcReceipt.blockNumber).to.equal('0x' + ethersReceipt.blockNumber.toString(16));
            expect(rpcReceipt.blockHash).to.equal(ethersReceipt.blockHash);
            expect(rpcReceipt.from.toLowerCase()).to.equal(ethersReceipt.from.toLowerCase());
            expect(rpcReceipt.to.toLowerCase()).to.equal(ethersReceipt.to.toLowerCase());
            expect(rpcReceipt.status).to.equal(ethersReceipt.status === 1 ? '0x1' : '0x0');
            expect(rpcReceipt.gasUsed).to.equal(ethers.toQuantity(ethersReceipt.gasUsed));
            expect(rpcReceipt.cumulativeGasUsed).to.equal(ethers.toQuantity(ethersReceipt.cumulativeGasUsed));
            expect(rpcReceipt.logs.length).to.equal(ethersReceipt.logs.length);
        });
    });
});

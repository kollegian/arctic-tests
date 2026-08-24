import { ContractTransactionReceipt, ethers } from "ethers";
import { SeiUser, UserFactory } from "../../shared/User";
import {Cw721Token, Erc721Token} from "../../shared/Token";
import { expect } from "chai";
import { AtomicTxSender } from "../../shared/TxBuilder";
import { EvmRpcClient } from "../../shared/RpcClient";
import fs from "fs";
import {clearSetCode} from "../chain_tests/pectra_upgrade/utils";
import {requireLegacyComponents} from '../../shared/seiLegacyComponents';

describe('ERC721 Tests', function () {
    this.timeout(10 * 60 * 1000);

    let admin: SeiUser, alice: SeiUser, bob: SeiUser, eve: SeiUser;
    let users: SeiUser[];
    let rpcClient: EvmRpcClient;
    let erc721Contract: Erc721Token;
    let cw721PointerContract: Cw721Token;
    let mintTxReceipt: ContractTransactionReceipt;
    let transferTxReceipt: ContractTransactionReceipt;
    let approvalTxReceipt: ContractTransactionReceipt;
    let failedTxBlockNumber: string;
    let failedTxBlockHash: string;
    let failedTxHash: string;
    let pointerAddress: string;
    const nftStartId = Math.floor(Math.random() * 1000000) + 2000;

    before('Deploys contracts and initializes users', async () => {
        admin = await UserFactory.createAdminUser();
        
        // Clear any 7702 delegation on admin account so safeMint works
        // (7702 wallets have code, which triggers onERC721Received callback that fails)
        console.log('Clearing 7702 delegation on admin account...');
        try {
            await clearSetCode(admin);
            console.log('7702 delegation cleared successfully');
        } catch (e) {
            console.log('No 7702 delegation to clear or already cleared');
        }
        
        const erc721Address = JSON.parse(fs.readFileSync('./tests/tokens/contractAddresses.json', 'utf8')).erc721Address;
        erc721Contract = new Erc721Token(admin, erc721Address);
        console.log('Using existing ERC721 contract at:', erc721Address);
        console.log('Using random nftStartId:', nftStartId);
        users = await UserFactory.createSeiUsers(admin, 3, true);
        rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
        alice = users[0];
        bob = users[1];
        eve = users[2];
    });

    describe('Write ops for erc721 tests', function () {
        it('Given that an erc721 deployed, admin can mint tokens', async () => {
            const mintTx = await erc721Contract.safeMint(admin.evmAddress, nftStartId + 1);
            mintTxReceipt = await mintTx.wait() as ContractTransactionReceipt;

            // Validate that the nft is minted
            const ownerInfo = await erc721Contract.ownerOf(nftStartId + 1);
            expect(ownerInfo).to.equal(admin.evmAddress);
        });

        it('Alice can try to mint an already mined nft and the tx is going to fail', async () => {
            const data = erc721Contract.getContract().interface.encodeFunctionData('safeMint', [admin.evmAddress, nftStartId + 1]);
            const signedTx1 = await AtomicTxSender.signEvmTransaction(admin, erc721Contract.getAddress(), data);
            const signedTx2 = await AtomicTxSender.signEvmTransaction(users[0], erc721Contract.getAddress(), data);

            const txHashes = await Promise.all([
                AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx1, admin),
                AtomicTxSender.sendRawTransaction(users[0].evmRpcEndpoint, signedTx2, users[0]),
            ]);
            failedTxHash = txHashes[0];
            const receipt = await AtomicTxSender.requireEvmReceipt(rpcClient, failedTxHash);
            failedTxBlockNumber = receipt.blockNumber;
            failedTxBlockHash = receipt.blockHash;
        });

        // The five cases below read the failed tx's coordinates from the test
        // above. Without this gate an unset coordinate reaches the node as JSON
        // null and comes back as an argument-decode error, so one root failure
        // reports as six unrelated-looking ones.
        function requireFailedTxContext() {
            if (!failedTxHash || !failedTxBlockNumber || !failedTxBlockHash) {
                throw new Error(
                    'failed-tx coordinates unset — the preceding "mint an already mined nft" test did not complete; fix that failure first',
                );
            }
        }

        it('Alice will see the failed tx event on eth_getBlocksByNumber', async () => {
            requireFailedTxContext();
            const blockResult = await rpcClient.getBlockByNumber(failedTxBlockNumber, true);
            const rpcResult = await rpcClient.getTransactionReceipt(failedTxHash);
            expect(blockResult.transactions.length).to.be.greaterThan(0);
            const tx = await blockResult.transactions.find((t) => t.hash === failedTxHash);

            expect(rpcResult.blockNumber).to.equal(tx.blockNumber);
            expect(rpcResult.blockHash).to.equal(tx.blockHash);
            expect(rpcResult.transactionIndex).to.equal(tx.transactionIndex);
            expect(rpcResult.from).to.equal(tx.from);
            expect(rpcResult.to).to.equal(tx.to);
            expect(Number(rpcResult.gasUsed)).to.be.lte(Number(tx.gas));
            // expect(Number(rpcResult.effectiveGasPrice)).to.be.eq(Number(tx.gasPrice));
            expect(Number(rpcResult.effectiveGasPrice)).to.be.lte(Number(tx.maxFeePerGas));
            expect(rpcResult.status).to.equal(ethers.toQuantity(0), 'Transaction did not fail');
        });

        it('Alice will see the failed tx event on sei_getBlocksByNumber', async function () {
            requireLegacyComponents(this);
            requireFailedTxContext();
            const blockResult = await rpcClient.sei_getBlockByNumber(failedTxBlockNumber, true);
            expect(blockResult.transactions.length).to.be.greaterThan(0);
            const rpcResult = await rpcClient.getTransactionReceipt(failedTxHash);
            expect(blockResult.transactions.length).to.be.greaterThan(0);
            const tx = await blockResult.transactions.find((t) => t.hash === failedTxHash);

            expect(rpcResult.blockNumber).to.equal(tx.blockNumber);
            expect(rpcResult.blockHash).to.equal(tx.blockHash);
            expect(rpcResult.transactionIndex).to.equal(tx.transactionIndex);
            expect(rpcResult.from).to.equal(tx.from);
            expect(rpcResult.to).to.equal(tx.to);
            expect(Number(rpcResult.gasUsed)).to.be.lte(Number(tx.gas));
            // expect(Number(rpcResult.effectiveGasPrice)).to.be.eq(Number(tx.gasPrice));
            expect(Number(rpcResult.effectiveGasPrice)).to.be.lte(Number(tx.maxFeePerGas));
            expect(rpcResult.status).to.equal(ethers.toQuantity(0), 'Transaction did not fail');
        });

        it('Alice will see the failed tx event on eth_getBlocksByHash', async () => {
            requireFailedTxContext();
            const blockResult = await rpcClient.getBlockByHash(failedTxBlockHash, true);
            expect(blockResult.transactions.length).to.be.greaterThan(0);

            const rpcResult = await rpcClient.getTransactionReceipt(failedTxHash);
            expect(blockResult.transactions.length).to.be.greaterThan(0);
            const tx = await blockResult.transactions.find((t) => t.hash === failedTxHash);

            expect(rpcResult.blockNumber).to.equal(tx.blockNumber);
            expect(rpcResult.blockHash).to.equal(tx.blockHash);
            expect(rpcResult.transactionIndex).to.equal(tx.transactionIndex);
            expect(rpcResult.from).to.equal(tx.from);
            expect(rpcResult.to).to.equal(tx.to);
            expect(Number(rpcResult.gasUsed)).to.be.lte(Number(tx.gas));
            // expect(Number(rpcResult.effectiveGasPrice)).to.be.eq(Number(tx.gasPrice));
            expect(Number(rpcResult.effectiveGasPrice)).to.be.lte(Number(tx.maxFeePerGas));
            expect(rpcResult.status).to.equal(ethers.toQuantity(0), 'Transaction did not fail');
        });

        it('Alice will see the failed tx event on sei_getBlocksByHash', async function () {
            requireLegacyComponents(this);
            requireFailedTxContext();
            const blockResult = await rpcClient.sei_getBlockByHash(failedTxBlockHash, true);
            expect(blockResult.transactions.length).to.be.greaterThan(0);

            const rpcResult = await rpcClient.getTransactionReceipt(failedTxHash);
            expect(blockResult.transactions.length).to.be.greaterThan(0);
            const tx = await blockResult.transactions.find((t) => t.hash === failedTxHash);

            expect(rpcResult.blockNumber).to.equal(tx.blockNumber);
            expect(rpcResult.blockHash).to.equal(tx.blockHash);
            expect(rpcResult.transactionIndex).to.equal(tx.transactionIndex);
            expect(rpcResult.from).to.equal(tx.from);
            expect(rpcResult.to).to.equal(tx.to);
            expect(Number(rpcResult.gasUsed)).to.be.lte(Number(tx.gas));
            // expect(Number(rpcResult.effectiveGasPrice)).to.be.eq(Number(tx.gasPrice));
            expect(Number(rpcResult.effectiveGasPrice)).to.be.lte(Number(tx.maxFeePerGas));
            expect(rpcResult.status).to.equal(ethers.toQuantity(0), 'Transaction did not fail');
        });

        it('Alice will see the failed tx event on eth_getTransactionReceipt', async () => {
            requireFailedTxContext();
            const receipt = await rpcClient.getTransactionReceipt(failedTxHash);
            expect(receipt).to.not.be.null;
            expect(receipt.status).to.equal(ethers.toQuantity(0), 'Transaction did not fail');
        });

        it('Alice can mint an nft on evm runtime and calls safe transfer to Bob', async () => {
            const mintTx = await erc721Contract.safeMint(admin.evmAddress, nftStartId + 2);
            await mintTx.wait();

            // Admin transfers to Bob
            const transferTx = await erc721Contract.transferFrom(admin.evmAddress, bob.evmAddress, nftStartId + 2);
            transferTxReceipt = await transferTx.wait() as ContractTransactionReceipt;

            // Validate transfers
            const bobToken = await erc721Contract.ownerOf(nftStartId + 2);
            expect(bobToken).to.equal(bob.evmAddress);
        });

        it('Given that there are multiple txs in the same block (Alice mints another nft and bob sends nft back to alice), Alice can see the nft transfer event with eth_getLogs', async () => {
            const mintTxData = erc721Contract.contract.interface.encodeFunctionData('safeMint', [admin.evmAddress, nftStartId + 3]);
            const transferTxData = erc721Contract.contract.interface.encodeFunctionData('transferFrom', [bob.evmAddress, admin.evmAddress, nftStartId + 2]);

            const signedTx1 = await AtomicTxSender.signEvmTransaction(admin, erc721Contract.getAddress(), mintTxData);
            const signedTx2 = await AtomicTxSender.signEvmTransaction(bob, erc721Contract.getAddress(), transferTxData);
            const [mintTx, transferTx] = await Promise.all([
                AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx1, admin),
                AtomicTxSender.sendRawTransaction(bob.evmRpcEndpoint, signedTx2, bob),
            ]);
            const transferTxReceipt = await AtomicTxSender.requireEvmReceipt(rpcClient, transferTx);

            const logParams = {
                fromBlock: ethers.toQuantity(Number(transferTxReceipt.blockNumber) - 2),
                toBlock: ethers.toQuantity(Number(transferTxReceipt.blockNumber) + 3),
                address: erc721Contract.getAddress() as string,
            };

            const logs = await rpcClient.getLogs(logParams);
            expect(logs.length).to.be.eq(2, 'No logs found for the transactions');
        });


        it('Alice can approve nft rights to Bob on evm runtime', async () => {
            const approvalTx = await erc721Contract.approve(bob.evmAddress, nftStartId + 3);
            approvalTxReceipt = await approvalTx.wait() as ContractTransactionReceipt;

            // Validate approval
            const approvedAddress = await erc721Contract.getApproved(nftStartId + 3);
            expect(approvedAddress).to.equal(bob.evmAddress, 'NFT was not approved for Bob');
        });

        it('Bob can actually transfer nft that he has been authorized to', async () => {
            const transferTx = await erc721Contract.contract.connect(bob.evmWallet.wallet)
                .transferFrom(admin.evmAddress, eve.evmAddress, nftStartId + 3);
            transferTxReceipt = await transferTx.wait() as ContractTransactionReceipt;

            // Validate transfer
            const newOwner = await erc721Contract.ownerOf(nftStartId + 3);
            expect(newOwner).to.equal(eve.evmAddress, 'NFT was not transferred to Eve');
        });

        it('Alice mints another nft and approves for Bob, but Eve cant transfer nft from alice', async () => {
            // Alice mints another NFT (tokenId: 4)
            const mintTx = await erc721Contract.safeMint(admin.evmAddress, nftStartId + 4);
            await mintTx.wait();

            // Alice approves Bob for the minted NFT
            const approvalTx = await erc721Contract.approve(bob.evmAddress, nftStartId + 4);
            await approvalTx.wait();

            // Ensure that Bob is actually approved
            const approvedForToken = await erc721Contract.getApproved(nftStartId + 4);
            expect(approvedForToken).to.equal(bob.evmAddress, 'Bob was not approved to transfer NFT');

            // Eve tries to transfer NFT from Alice but should fail
            try {
                await erc721Contract.contract.connect(eve.evmWallet.wallet).transferFrom(admin.evmAddress, eve.evmAddress, nftStartId + 4);
                throw new Error('Transfer should have failed');
            } catch (e: any) {
                expect(e.message).to.include('execution reverted');
            }
        });
    });

    describe('Read ops for erc721 tests', function (){

        it('Alice can see the nft mint event with eth_getLogs', async () => {
            const logParams = {
                fromBlock: ethers.toQuantity(mintTxReceipt.blockNumber - 2),
                toBlock: ethers.toQuantity(mintTxReceipt.blockNumber + 3),
                address: erc721Contract.getAddress() as string,
            };
            const logs = await rpcClient.getLogs(logParams);
            expect(logs.length).to.be.greaterThan(0, 'No logs found for the mint transaction');

            const parsedLogs = logs
                .map((log: { topics: ReadonlyArray<string>; data: string; }) => {
                    try {
                        return erc721Contract.getContract().interface.parseLog(log);
                    } catch (err) {
                        return null;
                    }
                })
                .filter((e): e is any => e !== null);
            expect(parsedLogs).to.not.be.empty;

            const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
            expect(transferEvent).to.exist;
            expect(transferEvent?.args.from).to.equal(ethers.ZeroAddress);
            expect(transferEvent?.args.to).to.equal(admin.evmAddress);
            expect(transferEvent?.args.tokenId.toString()).to.equal((nftStartId + 1).toString());
        });

        it('Alice can see the nft mint event with sei_getLogs', async function () {
            requireLegacyComponents(this);
            const logParams = {
                fromBlock: ethers.toQuantity(mintTxReceipt.blockNumber - 2),
                toBlock: ethers.toQuantity(mintTxReceipt.blockNumber + 3),
                address: erc721Contract.getAddress() as string,
            };
            const logs = await rpcClient.sei_getLogs(logParams);
            expect(logs.length).to.be.greaterThan(0, 'No logs found for the mint transaction');

            const parsedLogs = logs
                .map((log: { topics: ReadonlyArray<string>; data: string; }) => {
                    try {
                        return erc721Contract.getContract().interface.parseLog(log);
                    } catch (err) {
                        return null;
                    }
                })
                .filter((e): e is any => e !== null);
            expect(parsedLogs).to.not.be.empty;

            const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
            expect(transferEvent).to.exist;
            expect(transferEvent?.args.from).to.equal(ethers.ZeroAddress);
            expect(transferEvent?.args.to).to.equal(admin.evmAddress);
            expect(transferEvent?.args.tokenId.toString()).to.equal((nftStartId + 1).toString());
        });

        it('Alice can see the nft mint event with eth_getBlocksByNumber with tx details full', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(mintTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft mint event with eth_getBlocksByNumber with tx details minimal', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(mintTxReceipt.blockNumber), false);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft mint event with sei_getBlocksByNumber', async function () {
            requireLegacyComponents(this);
            const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(mintTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft mint event with eth_getBlocksByHash', async () => {
            const block = await rpcClient.getBlockByHash(mintTxReceipt.blockHash, true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft mint event with sei_getBlocksByHash', async function () {
            requireLegacyComponents(this);
            const block = await rpcClient.sei_getBlockByHash(mintTxReceipt.blockHash, true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft mint event with eth_getTransactionReceipt', async () => {
            const receipt = await rpcClient.getTransactionReceipt(mintTxReceipt.hash);
            expect(receipt).to.not.be.null;
            expect(receipt.logs.length).to.be.greaterThan(0, 'No logs found in the transaction receipt');
            expect(receipt.status).to.be.eq(ethers.toQuantity(1), 'Transaction did not succeed');
            expect(receipt.to.toLowerCase()).to.be.eq((erc721Contract.getAddress() as string).toLowerCase());
        });

        it('Alice can see the nft transfer event with eth_getLogs', async () => {
            const logParams = {
                fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
                toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 3),
                address: erc721Contract.getAddress() as string,
            };
            const logs = await rpcClient.getLogs(logParams);
            expect(logs.length).to.be.greaterThan(0, 'No logs found for the transfer transaction');

            const parsedLogs = logs
                .map((log: { topics: ReadonlyArray<string>; data: string; }) => {
                    try {
                        return erc721Contract.getContract().interface.parseLog(log);
                    } catch (err) {
                        return null;
                    }
                })
                .filter((e): e is any => e !== null);

            expect(parsedLogs).to.not.be.empty;

            const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
            expect(transferEvent).to.exist;
            expect(transferEvent?.args.from).to.equal(admin.evmAddress);
            expect(transferEvent?.args.to).to.equal(eve.evmAddress);
            expect(transferEvent?.args.tokenId.toString()).to.equal((nftStartId + 3).toString());
        });

        it('Alice can see the nft transfer event with sei_getLogs', async function () {
            requireLegacyComponents(this);
            const logParams = {
                fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
                toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 3),
                address: erc721Contract.getAddress() as string,
            };
            const logs = await rpcClient.sei_getLogs(logParams);
            expect(logs.length).to.be.greaterThan(0, 'No logs found for the transfer transaction');

            const parsedLogs = logs
                .map((log: { topics: ReadonlyArray<string>; data: string }) => {
                    try {
                        return erc721Contract.getContract().interface.parseLog(log);
                    } catch (err) {
                        return null;
                    }
                })
                .filter((e): e is any => e !== null);

            expect(parsedLogs).to.not.be.empty;

            const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
            expect(transferEvent).to.exist;
            expect(transferEvent?.args.from).to.equal(admin.evmAddress);
            expect(transferEvent?.args.to).to.equal(eve.evmAddress);
            expect(transferEvent?.args.tokenId.toString()).to.equal((nftStartId + 3).toString());
        });

        it('Alice can see the nft transfer event with eth_getBlocksByNumber with tx details full', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft transfer event with eth_getBlocksByNumber with tx details minimal', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), false);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft transfer event with sei_getBlocksByNumber', async function () {
            requireLegacyComponents(this);
            const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft transfer event with eth_getBlocksByHash', async () => {
            const block = await rpcClient.getBlockByHash(transferTxReceipt.blockHash, true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft transfer event with sei_getBlocksByHash', async function () {
            requireLegacyComponents(this);
            const block = await rpcClient.sei_getBlockByHash(transferTxReceipt.blockHash, true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft transfer event with eth_getTransactionReceipt', async () => {
            const receipt = await rpcClient.getTransactionReceipt(transferTxReceipt.hash);
            expect(receipt).to.not.be.null;
            expect(receipt.logs.length).to.be.greaterThan(0, 'No logs found in the transaction receipt');
            expect(receipt.status).to.be.eq(ethers.toQuantity(1), 'Transaction did not succeed');
            expect(receipt.to.toLowerCase()).to.be.eq((erc721Contract.getAddress() as string).toLowerCase());
        });

        it('Alice can see nft approve event with eth_getLogs', async () => {
            const logParams = {
                fromBlock: ethers.toQuantity(approvalTxReceipt.blockNumber - 2),
                toBlock: ethers.toQuantity(approvalTxReceipt.blockNumber + 2),
                address: erc721Contract.getAddress() as string,
            };

            const logs = await rpcClient.getLogs(logParams);
            expect(logs.length).to.be.greaterThan(0, 'No logs found for the approval transaction');

            const parsedLogs = logs
                .map((log: { topics: ReadonlyArray<string>; data: string }) => {
                    try {
                        return erc721Contract.getContract().interface.parseLog(log);
                    } catch (err) {
                        return null;
                    }
                })
                .filter((e): e is any => e !== null);

            expect(parsedLogs).to.not.be.empty;

            const approvalEvent = parsedLogs.find((e) => e.name === 'Approval');
            expect(approvalEvent).to.exist;
            expect(approvalEvent?.args.owner).to.equal(admin.evmAddress);
            expect(approvalEvent?.args.approved).to.equal(bob.evmAddress);
            expect(approvalEvent?.args.tokenId.toString()).to.equal((nftStartId + 3).toString());
        });

        it('Alice can see nft approve event with sei_getLogs', async function () {
            requireLegacyComponents(this);
            const logParams = {
                fromBlock: ethers.toQuantity(approvalTxReceipt.blockNumber - 2),
                toBlock: ethers.toQuantity(approvalTxReceipt.blockNumber + 2),
                address: erc721Contract.getAddress() as string,
            };

            const logs = await rpcClient.sei_getLogs(logParams);
            expect(logs.length).to.be.greaterThan(0, 'No logs found for the approval transaction');

            const parsedLogs = logs
                .map((log: { topics: ReadonlyArray<string>; data: string }) => {
                    try {
                        return erc721Contract.getContract().interface.parseLog(log);
                    } catch (err) {
                        return null;
                    }
                })
                .filter((e): e is any => e !== null);

            expect(parsedLogs).to.not.be.empty;

            const approvalEvent = parsedLogs.find((e) => e.name === 'Approval');
            expect(approvalEvent).to.exist;
            expect(approvalEvent?.args.owner).to.equal(admin.evmAddress);
            expect(approvalEvent?.args.approved).to.equal(bob.evmAddress);
            expect(approvalEvent?.args.tokenId.toString()).to.equal((nftStartId + 3).toString());
        });

        it('Alice can see nft approve event with eth_getBlocksByNumber', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(approvalTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see nft approve event with sei_getBlocksByNumber', async function () {
            requireLegacyComponents(this);
            const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(approvalTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Bobs transfer will appear correctly on eth_getLogs', async () => {
            const logParams = {
                fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
                toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 2),
                address: erc721Contract.getAddress() as string,
            };

            const logs = await rpcClient.getLogs(logParams);
            expect(logs.length).to.be.greaterThan(0, 'No logs found for the transfer transaction');

            const parsedLogs = logs
                .map((log: { topics: ReadonlyArray<string>; data: string }) => {
                    try {
                        return erc721Contract.getContract().interface.parseLog(log);
                    } catch (err) {
                        return null;
                    }
                })
                .filter((e): e is any => e !== null);

            expect(parsedLogs).to.not.be.empty;

            const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
            expect(transferEvent).to.exist;
            expect(transferEvent?.args.from).to.equal(admin.evmAddress);
            expect(transferEvent?.args.to).to.equal(eve.evmAddress);
            expect(transferEvent?.args.tokenId.toString()).to.equal((nftStartId + 3).toString());
        });

        it('Bobs transfer will appear correctly on sei_getLogs', async function () {
            requireLegacyComponents(this);
            const logParams = {
                fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
                toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 2),
                address: erc721Contract.getAddress() as string,
            };

            const logs = await rpcClient.sei_getLogs(logParams);
            expect(logs.length).to.be.greaterThan(0, 'No logs found for the transfer transaction');

            const parsedLogs = logs
                .map((log: { topics: ReadonlyArray<string>; data: string }) => {
                    try {
                        return erc721Contract.getContract().interface.parseLog(log);
                    } catch (err) {
                        return null;
                    }
                })
                .filter((e): e is any => e !== null);

            expect(parsedLogs).to.not.be.empty;

            const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
            expect(transferEvent).to.exist;
            expect(transferEvent?.args.from).to.equal(admin.evmAddress);
            expect(transferEvent?.args.to).to.equal(eve.evmAddress);
            expect(transferEvent?.args.tokenId.toString()).to.equal((nftStartId + 3).toString());
        });

        it('Bobs transfer will appear correctly on eth_getBlocksByNumber', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });
        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with sei_getLogs', async function () {
            requireLegacyComponents(this);
            const logParams = {
                fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
                toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 3),
                address: erc721Contract.getAddress() as string,
            };

            const logs = await rpcClient.sei_getLogs(logParams);
            expect(logs.length).to.be.gte(1, 'No logs found for the transactions');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getBlocksByNumber with tx details full', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.gte(1, 'Expected multiple transactions in the block');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getBlocksByNumber with tx details minimal', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), false);
            expect(block.transactions.length).to.be.gte(1, 'Expected multiple transactions in the block');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with sei_getBlocksByNumber', async function () {
            requireLegacyComponents(this);
            const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.gte(1, 'Expected multiple transactions in the block');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getBlocksByHash', async () => {
            const block = await rpcClient.getBlockByHash(transferTxReceipt.blockHash, true);
            expect(block.transactions.length).to.be.gte(1, 'Expected multiple transactions in the block');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with sei_getBlocksByHash', async function () {
            requireLegacyComponents(this);
            const block = await rpcClient.sei_getBlockByHash(transferTxReceipt.blockHash, true);
            expect(block.transactions.length).to.be.gte(1, 'Expected multiple transactions in the block');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getTransactionReceipt', async () => {
            const receipt = await rpcClient.getTransactionReceipt(transferTxReceipt.hash);
            expect(receipt).to.not.be.null;
            expect(receipt.logs.length).to.be.greaterThan(0, 'No logs found in the transaction receipt');
            expect(receipt.status).to.be.eq(ethers.toQuantity(1), 'Transaction did not succeed');
        });


    })
});

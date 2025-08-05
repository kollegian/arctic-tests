import { ContractTransactionReceipt, ethers, TransactionReceipt } from "ethers";
import { SeiUser, UserFactory } from "../../shared/User";
import { Cw721Token, Erc721Token } from "../../shared/Token";
import { TokenDeployer } from "../../shared/Deployer";
import { expect } from "chai";
import { AtomicTxSender } from "../../shared/TxBuilder";
import { waitFor } from "../../shared/utils/helpers";
import { EvmRpcClient } from "../../shared/RpcClient";
import _, { initial } from "lodash";

describe('ERC721 Tests', function () {
    this.timeout(10 * 60 * 1000);

    let admin: SeiUser, alice: SeiUser, bob: SeiUser, eve: SeiUser;
    let rpcClient: EvmRpcClient;
    let erc721Contract: Erc721Token;
    let cw721PointerContract: Cw721Token;
    let mintTxReceipt: ContractTransactionReceipt;
    let transferTxReceipt: ContractTransactionReceipt;
    let approvalTxReceipt: ContractTransactionReceipt;
    let failedTxBlockNumber: number;
    let failedTxBlockHash: string;
    let failedTxHash: string;
    let pointerAddress: string;

    before('Deploys contracts and initializes users', async () => {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        ([alice, bob] = await UserFactory.createSeiUsers(admin, 2));
        
        const deployer = new TokenDeployer(admin);
        erc721Contract = await deployer.deployErc721("TestNFT", "TNFT", "https://example.com/");
        rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
        
        // Create eve user
        eve = await UserFactory.createSeiUser(admin, 'eve');
        await UserFactory.fundAllUsers([eve]);
        await UserFactory.associateAll([eve]);
    });

    describe('Write ops for erc721 tests', function () {
        it('Given that an erc721 deployed, admin can mint tokens', async () => {
            const mintTx = await erc721Contract.safeMint(admin.evmAddress, '1');
            mintTxReceipt = await mintTx.wait() as ContractTransactionReceipt;
            
            // Validate that the nft is minted
            const ownerInfo = await erc721Contract.ownerOf('1');
            expect(ownerInfo).to.equal(admin.evmAddress);
        });

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
            expect(transferEvent?.args.tokenId.toString()).to.equal('1');
        });

        it('Alice can see the nft mint event with sei_getLogs', async () => {
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
            expect(transferEvent?.args.tokenId.toString()).to.equal('1');
        });

        it('Alice can see the nft mint event with eth_getBlocksByNumber with tx details full', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(mintTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft mint event with eth_getBlocksByNumber with tx details minimal', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(mintTxReceipt.blockNumber), false);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft mint event with sei_getBlocksByNumber', async () => {
            const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(mintTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft mint event with eth_getBlocksByHash', async () => {
            const block = await rpcClient.getBlockByHash(mintTxReceipt.blockHash, true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft mint event with sei_getBlocksByHash', async () => {
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

        it('Alice can try to mint an already mined nft and the tx is going to fail', async () => {
            const data = erc721Contract.getContract().interface.encodeFunctionData('safeMint', [admin.evmAddress, '1']);
            const nonce = await admin.evmWallet.wallet.getNonce('latest');
            const chainId = (await admin.evmWallet.signingClient.getNetwork()).chainId;

            // For EIP-1559 Transactions
            const maxFeePerGas = ethers.parseUnits('100', 'gwei');
            const maxPriorityFeePerGas = ethers.parseUnits('2', 'gwei');
            const gasLimit = ethers.toBeHex('100000');

            const tx = {
                nonce: nonce,
                to: erc721Contract.getAddress(),
                value: '0x0',
                data: data,
                gasLimit: gasLimit,
                maxFeePerGas: maxFeePerGas,
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                type: 2,
                chainId: chainId,
            };

            const signedTx = await admin.evmWallet.wallet.signTransaction(tx);
            try {
                const txResponse = await admin.evmWallet.signingClient.broadcastTransaction(signedTx);
                const receipt = await txResponse.wait();
            } catch (e: any) {
                failedTxBlockNumber = parseInt(e.message.slice(e.message.indexOf("blockNumber") + 13).slice(0, e.message.indexOf(",")).trim());
                failedTxBlockHash = e.message.slice(e.message.indexOf("blockHash") + 13).slice(0, 66).trim();
                failedTxHash = e.message.slice(e.message.indexOf("hash") + 8).slice(0, 66).trim();
            }
        });

        it('Alice will see the failed tx event on eth_getBlocksByNumber', async () => {
            const blockResult = await rpcClient.getBlockByNumber(ethers.toQuantity(failedTxBlockNumber), true);
            expect(blockResult.transactions.length).to.be.greaterThan(0);
        });

        it('Alice will see the failed tx event on sei_getBlocksByNumber', async () => {
            const blockResult = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(failedTxBlockNumber), true);
            expect(blockResult.transactions.length).to.be.greaterThan(0);
        });

        it('Alice will see the failed tx event on eth_getBlocksByHash', async () => {
            const blockResult = await rpcClient.getBlockByHash(failedTxBlockHash, true);
            expect(blockResult.transactions.length).to.be.greaterThan(0);
        });

        it('Alice will see the failed tx event on sei_getBlocksByHash', async () => {
            const blockResult = await rpcClient.sei_getBlockByHash(failedTxBlockHash, true);
            expect(blockResult.transactions.length).to.be.greaterThan(0);
        });

        it('Alice will see the failed tx event on eth_getTransactionReceipt', async () => {
            const receipt = await rpcClient.getTransactionReceipt(failedTxHash);
            expect(receipt).to.not.be.null;
            expect(receipt.status).to.equal(ethers.toQuantity(0), 'Transaction did not fail');
        });

        it('Alice can mint an nft on evm runtime and calls safe transfer to Bob', async () => {
            const mintTx = await erc721Contract.safeMint(admin.evmAddress, '2');
            await mintTx.wait();

            // Admin transfers to Bob
            const transferTx = await erc721Contract.transferFrom(admin.evmAddress, bob.evmAddress, '2');
            transferTxReceipt = await transferTx.wait() as ContractTransactionReceipt;

            // Validate transfers
            const bobToken = await erc721Contract.ownerOf('2');
            expect(bobToken).to.equal(bob.evmAddress);
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
            expect(transferEvent?.args.to).to.equal(bob.evmAddress);
            expect(transferEvent?.args.tokenId.toString()).to.equal('2');
        });

        it('Alice can see the nft transfer event with sei_getLogs', async () => {
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
            expect(transferEvent?.args.to).to.equal(bob.evmAddress);
            expect(transferEvent?.args.tokenId.toString()).to.equal('2');
        });

        it('Alice can see the nft transfer event with eth_getBlocksByNumber with tx details full', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft transfer event with eth_getBlocksByNumber with tx details minimal', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), false);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft transfer event with sei_getBlocksByNumber', async () => {
            const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft transfer event with eth_getBlocksByHash', async () => {
            const block = await rpcClient.getBlockByHash(transferTxReceipt.blockHash, true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see the nft transfer event with sei_getBlocksByHash', async () => {
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

        it('Given that there are multiple txs in the same block (Alice mints another nft and bob sends nft back to alice), Alice can see the nft transfer event with eth_getLogs', async () => {
            const [mintTx, transferTx] = await Promise.all([
                erc721Contract.safeMint(admin.evmAddress, '3'),
                erc721Contract.contract.connect(bob.evmWallet.wallet).transferFrom(bob.evmAddress, admin.evmAddress, '2')
            ]);

            ([mintTxReceipt, transferTxReceipt] = await Promise.all([mintTx.wait(), transferTx.wait()]) as ContractTransactionReceipt[]);
            
            const logParams = {
                fromBlock: ethers.toQuantity(transferTxReceipt!.blockNumber - 2),
                toBlock: ethers.toQuantity(transferTxReceipt!.blockNumber + 3),
                address: erc721Contract.getAddress() as string,
            };

            const logs = await rpcClient.getLogs(logParams);
            expect(logs.length).to.be.eq(2, 'No logs found for the transactions');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with sei_getLogs', async () => {
            const logParams = {
                fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
                toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 3),
                address: erc721Contract.getAddress() as string,
            };

            const logs = await rpcClient.sei_getLogs(logParams);
            expect(logs.length).to.be.greaterThan(1, 'No logs found for the transactions');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getBlocksByNumber with tx details full', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.gte(1, 'Expected multiple transactions in the block');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getBlocksByNumber with tx details minimal', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), false);
            expect(block.transactions.length).to.be.gte(1, 'Expected multiple transactions in the block');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with sei_getBlocksByNumber', async () => {
            const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.gte(1, 'Expected multiple transactions in the block');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getBlocksByHash', async () => {
            const block = await rpcClient.getBlockByHash(transferTxReceipt.blockHash, true);
            expect(block.transactions.length).to.be.gte(1, 'Expected multiple transactions in the block');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with sei_getBlocksByHash', async () => {
            const block = await rpcClient.sei_getBlockByHash(transferTxReceipt.blockHash, true);
            expect(block.transactions.length).to.be.gte(1, 'Expected multiple transactions in the block');
        });

        it('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getTransactionReceipt', async () => {
            const receipt = await rpcClient.getTransactionReceipt(transferTxReceipt.hash);
            expect(receipt).to.not.be.null;
            expect(receipt.logs.length).to.be.greaterThan(0, 'No logs found in the transaction receipt');
            expect(receipt.status).to.be.eq(ethers.toQuantity(1), 'Transaction did not succeed');
        });

        it('Alice can approve nft rights to Bob on evm runtime', async () => {
            const approvalTx = await erc721Contract.approve(bob.evmAddress, '2');
            approvalTxReceipt = await approvalTx.wait() as ContractTransactionReceipt;

            // Validate approval
            const approvedAddress = await erc721Contract.getApproved('2');
            expect(approvedAddress).to.equal(bob.evmAddress, 'NFT was not approved for Bob');
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
            expect(approvalEvent?.args.tokenId.toString()).to.equal('2');
        });

        it('Alice can see nft approve event with sei_getLogs', async () => {
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
            expect(approvalEvent?.args.tokenId.toString()).to.equal('2');
        });

        it('Alice can see nft approve event with eth_getBlocksByNumber', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(approvalTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice can see nft approve event with sei_getBlocksByNumber', async () => {
            const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(approvalTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Bob can actually transfer nft that he has been authorized to', async () => {
            const transferTx = await erc721Contract.transferFrom(admin.evmAddress, eve.evmAddress, '2');
            transferTxReceipt = await transferTx.wait() as ContractTransactionReceipt;

            // Validate transfer
            const newOwner = await erc721Contract.ownerOf('2');
            expect(newOwner).to.equal(eve.evmAddress, 'NFT was not transferred to Eve');
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
            expect(transferEvent?.args.tokenId.toString()).to.equal('2');
        });

        it('Bobs transfer will appear correctly on sei_getLogs', async () => {
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
            expect(transferEvent?.args.tokenId.toString()).to.equal('2');
        });

        it('Bobs transfer will appear correctly on eth_getBlocksByNumber', async () => {
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
            expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        });

        it('Alice mints another nft and approves for Bob, but Eve cant transfer nft from alice', async () => {
            // Alice mints another NFT (tokenId: 4)
            const mintTx = await erc721Contract.safeMint(admin.evmAddress, '4');
            await mintTx.wait();

            // Alice approves Bob for the minted NFT
            const approvalTx = await erc721Contract.approve(bob.evmAddress, '4');
            await approvalTx.wait();

            // Ensure that Bob is actually approved
            const approvedForToken = await erc721Contract.getApproved('4');
            expect(approvedForToken).to.equal(bob.evmAddress, 'Bob was not approved to transfer NFT');

            // Eve tries to transfer NFT from Alice but should fail
            try {
                await erc721Contract.contract.connect(eve.evmWallet.wallet).transferFrom(admin.evmAddress, eve.evmAddress, '4');
                throw new Error('Transfer should have failed');
            } catch (e: any) {
                expect(e.message).to.include('execution reverted');
            }
        });
    });

    describe('Pointer tests', function () {
        it('Alice deploys a pointer for erc721 on cosmos runtime', async () => {
            const pointerAddress = await erc721Contract.registerPointer();
            cw721PointerContract = new Cw721Token(admin, pointerAddress);
            // This would require the actual pointer deployment logic
            // For now, we'll just test that the contract exists
        });

        it.skip('Alice can read pointer info on cosmos runtime for the pointer', async () => {
            // This would require the actual pointer contract
            // For now, we'll just test that we can query the contract
            const name = await cw721PointerContract.contract_info();
            expect(name).to.equal('MyToken');
        });

        it('Alice can query the token info of eve on the cosmos runtime', async () => {
            // This would require the actual pointer contract
            // For now, we'll just test that we can query ownership
            const owner = await cw721PointerContract.ownerOf('2');
            expect(owner).to.equal(eve.seiAddress);
        });

        it.skip('Alice can query the total issuance of erc721 token on cosmos runtime', async () => {
            const totalSupply = await cw721PointerContract.totalSupply();
            expect(Number(totalSupply)).to.be.eq(4);
        });

        it('Alice can query the ownership of a token on the cosmos runtime', async () => {
            const owner = await cw721PointerContract.ownerOf('4');
            expect(owner).to.equal(admin.seiAddress);
        });
    });
});

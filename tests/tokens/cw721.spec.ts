import {SeiUser, User, UserFactory} from "../../shared/User";
import * as TestConfig from "../../config/testConfig.json";
import {TokenDeployer} from "../../shared/Deployer";
import {Cw721Token, Erc721Token} from "../../shared/Token";
import {EvmRpcClient} from "../../shared/RpcClient";
import {ethers} from "ethers";
import {expect} from "chai";
import {AtomicTxSender} from "../../shared/TxBuilder";
import pointerAbi from "../../artifacts/contracts/CW721ERC721Pointer.sol/CW721ERC721Pointer.json";
import {CW721ERC721Pointer} from "../../typechain-types";
import {waitFor} from "../../shared/utils/helpers";

describe('CW721 Tests', function () {
    let admin: SeiUser, alice: SeiUser, ferdie: SeiUser, unassociatedUser: SeiUser;
    let cwContract: Cw721Token;
    this.timeout(10 * 60 * 1000);
    let rpcClient: EvmRpcClient;
    let startBlockHeight: number;
    let endBlockHeight: number;
    let erc721PointerContract: CW721ERC721Pointer;
    let evmAndCosmosBlockHeight: number;
    const topic = ethers.id('Transfer(address,address,uint256)');
    const endpoints = ['sei_getLogs', 'sei_getFilterLogs', 'sei_getBlockByHash', 'sei_getBlockByNumber', 'eth_getLogs',
        'eth_getFilterLogs', 'eth_getBlockByHash', 'eth_getBlockByNumber'];

    before('Deploys contracts', async () => {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        startBlockHeight = (await admin.evmWallet.signingClient.getBlock('latest'))!.number;
        ([alice, ferdie] = await UserFactory.createSeiUsers(admin, 2));
        const deployer = new TokenDeployer(admin);
        cwContract = await deployer.deployCw721('wasm_store/cw2981_royalties.wasm', {
            name: 'cw721',
            symbol: 'mycw',
            minter: admin.seiAddress
        }, 'mycw');
        rpcClient = new EvmRpcClient(TestConfig.evmRpcEndpoint, admin.evmWallet.signingClient);
    });

    describe('Write operations for cw721', function () {
        it('Admin mints an nft', async () => {
            const mintTx = await cwContract.mintTx('1', admin.seiAddress);
            const owner = await cwContract.ownerOf('1');
            expect(owner).to.equal(admin.seiAddress);
        });

        it('Admin transfers one nft to alice', async () => {
            const transferTx = await cwContract.safeTransferFrom(admin.seiAddress, alice.seiAddress, '1');
            const newOwner = await cwContract.ownerOf('1');
            expect(newOwner).to.equal(alice.seiAddress);
        });

        it('Admin mints multiple nfts in a single block', async () => {
            const transferTx = await cwContract.mintMultiple(['2', '3', '4'], [alice.seiAddress, alice.seiAddress, ferdie.seiAddress]);
            expect(await cwContract.ownerOf('2')).to.equal(alice.seiAddress);
            expect(await cwContract.ownerOf('3')).to.equal(alice.seiAddress);
            expect(await cwContract.ownerOf('4')).to.equal(ferdie.seiAddress);
        });

        it('Admin mints another nft', async () => {
            const transferTx = await cwContract.mintTx('5', admin.seiAddress);
            const owner = await cwContract.ownerOf('5');
            expect(owner).to.equal(admin.seiAddress);
            endBlockHeight = (await admin.evmWallet.signingClient.getBlock('latest'))!.number;
        });

        it('Admin mints another nft for unassociated user', async () => {
            unassociatedUser = await UserFactory.createUnassociatedUsers(admin);
            await cwContract.mintTx('6', unassociatedUser.seiAddress);
            expect(await cwContract.ownerOf('6')).to.be.eq(unassociatedUser.seiAddress);
        });

        it('Admin approves nft transfer for alice', async () => {
            await cwContract.approve(alice.seiAddress, '5');
            expect(await cwContract.getApproved('5', alice.seiAddress)).to.be.eq(alice.seiAddress);
            await cwContract.mintTx('7', admin.seiAddress);
            await cwContract.approve(unassociatedUser.seiAddress, '7');
        })


        for (const endpoint of endpoints) {
            //@Todo This will fail on atlantic 2. Need to skip
            it(`Before pointer deployment, ${endpoint} wont return any info`, async () => {
                const results = await rpcClient.checkAndReturnRpcResultsForBlock(startBlockHeight, endBlockHeight, endpoint, '', topic);
                expect(results.length).to.be.eq(0);
            });
        }

        it('Before pointer deployment debug traceBlock wont return any txs', async () => {
            for (let i = startBlockHeight; i <= endBlockHeight; i++) {
                const debugResult = await rpcClient.debugTraceByBlockNumber(ethers.toQuantity(i));
                expect(debugResult.length).to.be.eq(0);
            }
        });

        it('Deploys a pointer for cw721 contract', async () => {
            const cw721Pointer = await cwContract.deployPointer(admin.evmRpcEndpoint);
            expect(cw721Pointer).to.not.be.null;
            await waitFor(1);
            const pointerContractAddress = await cwContract.queryPointerAddress();
            erc721PointerContract = new ethers.Contract(pointerContractAddress, pointerAbi.abi,
                admin.evmWallet.signingClient) as unknown as CW721ERC721Pointer;
        });

        it('State is kept on wasm after pointer deployment', async () => {
            // Validate the balances. At this point Alice will have 1,2,3 and Ferdie will have 4. Admin will have 5
            expect(await cwContract.ownerOf('1')).to.be.eq(alice.seiAddress);
            expect(await cwContract.ownerOf('2')).to.be.eq(alice.seiAddress);
            expect(await cwContract.ownerOf('3')).to.be.eq(alice.seiAddress);
            expect(await cwContract.ownerOf('4')).to.be.eq(ferdie.seiAddress);
            expect(await cwContract.ownerOf('5')).to.be.eq(admin.seiAddress);
            expect(await cwContract.ownerOf('6')).to.be.eq(unassociatedUser.seiAddress);
        });

        it('State is migrated on evm side after deployment', async () => {
            expect(await erc721PointerContract.ownerOf('1')).to.be.eq(alice.evmAddress);
            expect(await erc721PointerContract.ownerOf('2')).to.be.eq(alice.evmAddress);
            expect(await erc721PointerContract.ownerOf('3')).to.be.eq(alice.evmAddress);
            expect(await erc721PointerContract.ownerOf('4')).to.be.eq(ferdie.evmAddress);
            expect(await erc721PointerContract.ownerOf('5')).to.be.eq(admin.evmAddress);
            try {
                expect(await erc721PointerContract.ownerOf('6')).to.be.eq(unassociatedUser.evmAddress);
                throw new Error('Should fail');
            } catch (e: any) {
                expect(e.message).to.not.eq('Should fail');
            }
        });

        it('Approvals are migrated on evm runtime', async () => {
            expect(await erc721PointerContract.getApproved('5')).to.be.eq(alice.evmAddress);
        });

        it('After association nft ownership can be queried on evm side', async () => {
            try {
                await erc721PointerContract.getApproved('7');
                throw new Error('Should fail');
            } catch (e: any) {
                expect(e.message).to.not.eq('Should fail');
            }

            await unassociatedUser.seiWallet.associate();
            expect(await erc721PointerContract.ownerOf('6')).to.be.eq(unassociatedUser.evmAddress);
        });

        it('After association nft approvals can be queried on evm side', async () => {
            expect(await erc721PointerContract.getApproved('7')).to.be.eq(unassociatedUser.evmAddress);
        });

        it('Alice cant safe transfer from an nft on evm side', async () => {
            try {
                const encodeTx = erc721PointerContract.connect(alice.evmWallet.wallet).interface
                    .encodeFunctionData('safeTransferFrom(address,address,uint256)', [admin.evmAddress, alice.evmAddress, '6']);
                const signedTx = await AtomicTxSender.signEvmTransaction(alice, erc721PointerContract.target, encodeTx);
                const broadcastResult = await admin.evmWallet.signingClient.broadcastTransaction(signedTx);
            } catch (e: any) {
                console.log(e);
                return;
            }
        });

        it('User transfers nft on cosmos runtime', async () => {
            //set alice as signer for cw contract
            cwContract.setSigner(alice);
            await cwContract.safeTransferFrom(alice.seiAddress, admin.seiAddress, '1');
            expect(await cwContract.ownerOf('1')).to.be.eq(admin.seiAddress);
            expect(await erc721PointerContract.ownerOf('1')).to.be.eq(admin.evmAddress);

            //set admin as signer
            cwContract.setSigner(admin);
        });

        it('User can transfer nft on evm runtime', async () => {
            const tx = await erc721PointerContract.connect(admin.evmWallet.wallet).transferFrom(admin.evmAddress, alice.evmAddress, '1');
            const receipt = await tx.wait();
            expect(await cwContract.ownerOf('1')).to.be.eq(alice.seiAddress);
        });

        it('Given that multiple evm txs on a same block, state is kept correctly', async () => {
            const encodedCall1 = erc721PointerContract.connect(alice.evmWallet.wallet)
                .interface.encodeFunctionData('safeTransferFrom(address,address,uint256)', [alice.evmAddress, admin.evmAddress, '1']);
            const encodedCall2 = erc721PointerContract.connect(admin.evmWallet.wallet)
                .interface.encodeFunctionData('safeTransferFrom(address,address,uint256)', [admin.evmAddress, alice.evmAddress, '5']);
            const signed = await AtomicTxSender.signEvmTransaction(alice, erc721PointerContract.target, encodedCall1);
            const signed2 = await AtomicTxSender.signEvmTransaction(admin, erc721PointerContract.target, encodedCall2);
            const results = await AtomicTxSender.sendMultipleEvmTxs([signed, signed2], admin.evmRpcEndpoint, admin);
            await waitFor(1);

            expect(await cwContract.ownerOf('1')).to.be.eq(admin.seiAddress);
            expect(await cwContract.ownerOf('5')).to.be.eq(alice.seiAddress);

            expect(await erc721PointerContract.ownerOf('1')).to.be.eq(admin.evmAddress);
            expect(await erc721PointerContract.ownerOf('5')).to.be.eq(alice.evmAddress);
        });

        it('Same user sends transfer tx on cosmos and one on evm runtime in the same block', async () => {
            const encodedCall1 = erc721PointerContract.connect(alice.evmWallet.wallet)
                .interface.encodeFunctionData('safeTransferFrom(address,address,uint256)', [alice.evmAddress, admin.evmAddress, '5']);
            const signedCall = await AtomicTxSender.signEvmTransaction(alice, erc721PointerContract.target, encodedCall1, false);
            const delayed = async () => {
                await waitFor(0.1);
                return AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedCall, admin)
            }
            //set alice as signer
            cwContract.setSigner(alice);
            const results = await Promise.all([
                cwContract.safeTransferFrom(alice.seiAddress, admin.seiAddress, '2'),
                delayed()
            ]);
            console.log(results);
            // a candidate for rpc testing https://seitrace.com/block/94616557?chain=arctic-1
            cwContract.setSigner(admin);
            evmAndCosmosBlockHeight = results[0].height;
            expect(await cwContract.ownerOf('2')).to.be.eq(admin.seiAddress);
            expect(await erc721PointerContract.ownerOf('2')).to.be.eq(admin.evmAddress);
            expect(await cwContract.ownerOf('5')).to.be.eq(admin.seiAddress);
            expect(await erc721PointerContract.ownerOf('5')).to.be.eq(admin.evmAddress);
        });
    })

    describe('Read operations for cw721', function () {
        let transactionIndexes = {};
        const syntheticEndpoints = ['sei_getLogs', 'sei_getFilterLogs', 'sei_getBlockByHash', 'sei_getBlockByNumber'];
        const evmEndpoints = ['eth_getLogs', 'eth_getFilterLogs', 'eth_getBlockByHash', 'eth_getBlockByNumber'];
        syntheticEndpoints.forEach(endpoint => {
            it(`After pointer registration synthetic events will be available on synthetic endpoint ${endpoint}`, async () => {
                const results = await rpcClient.checkAndReturnRpcResultsForBlock(evmAndCosmosBlockHeight - 2, evmAndCosmosBlockHeight, endpoint, erc721PointerContract.target, topic);
                expect(results.length).to.be.eq(2);
                if (endpoint.includes('Logs')) {
                    console.log(results);
                    results.forEach(result => {
                        expect(result.address).to.be.eq(erc721PointerContract.target.toLowerCase());
                        expect(result.topics.length).to.be.eq(4);
                        expect(result.topics[0]).to.be.eq(topic.toLowerCase());
                        expect(ethers.getAddress(result.topics[1].slice(-40))).to.be.eq(alice.evmAddress);
                        expect(ethers.getAddress(result.topics[2].slice(-40))).to.be.eq(admin.evmAddress);
                        expect(ethers.getNumber(result.topics[3])).to.be.oneOf([2, 5]);
                        transactionIndexes[result.transactionHash] = {
                            "transactionIndex": result.transactionIndex, "blockNumber": result.blockNumber,
                            "blockHash": result.blockHash, "from": ethers.getAddress(result.topics[1].slice(-40)), "to": ethers.getAddress(result.address.slice(-40)),
                        };
                    })
                } else {
                    const searchedTxs = results.filter(result => result.from === alice.evmAddress.toLowerCase());
                    searchedTxs.forEach(result => {
                        expect(result.from).to.be.eq(alice.evmAddress.toLowerCase());
                        expect(result.to).to.be.eq(erc721PointerContract.target.toLowerCase());
                    })
                }
            });
        });
        const syntheticBlockEndpoints = ['sei_getBlockByHash', 'sei_getBlockByNumber'];
        syntheticBlockEndpoints.forEach(endpoint => {
            it(`Synthetic log information matches with synthetic block information with ${endpoint}`, async () => {
                const blockResult = await rpcClient.checkAndReturnRpcResultsForBlock(evmAndCosmosBlockHeight - 2, evmAndCosmosBlockHeight, endpoint, '', topic);
                const searchedTxs = blockResult.filter(result => result.from === alice.evmAddress.toLowerCase());
                searchedTxs.forEach(result => {
                    expect(result.blockNumber).to.be.eq(transactionIndexes[result.hash].blockNumber);
                    expect(result.transactionIndex).to.be.eq(transactionIndexes[result.hash].transactionIndex);
                    expect(result.blockHash).to.be.eq(transactionIndexes[result.hash].blockHash);
                    expect(result.from).to.be.eq(transactionIndexes[result.hash].from.toLowerCase());
                    expect(result.to).to.be.eq(transactionIndexes[result.hash].to.toLowerCase());
                })
            });
        });

        evmEndpoints.forEach(endpoint => {
            it(`After pointer registration evm native events will be available on evm endpoint ${endpoint}`, async () => {
                const results = await rpcClient.checkAndReturnRpcResultsForBlock(evmAndCosmosBlockHeight - 2, evmAndCosmosBlockHeight, endpoint, erc721PointerContract.target, topic);
                expect(results.length).to.be.eq(1);
                if (endpoint.includes('Logs')) {
                    results.forEach(result => {
                        expect(result.address.toLowerCase()).to.be.eq(erc721PointerContract.target.toLowerCase());
                        expect(result.topics.length).to.be.eq(4);
                        expect(result.topics[0]).to.be.eq(topic);
                        expect(ethers.getAddress(result.topics[1].slice(-40))).to.be.eq(alice.evmAddress);
                        expect(ethers.getAddress(result.topics[2].slice(-40))).to.be.eq(admin.evmAddress);
                        expect(ethers.getNumber(result.topics[3])).to.be.eq(5);
                        transactionIndexes[result.transactionHash] = {
                            "transactionIndex": result.transactionIndex, "blockNumber": result.blockNumber,
                            "blockHash": result.blockHash, "from": ethers.getAddress(result.topics[1].slice(-40)), "to": ethers.getAddress(result.address.slice(-40)),
                        };
                    })
                } else {
                    const searchedTxs = results.filter(result => result.from === alice.evmAddress.toLowerCase());
                    searchedTxs.forEach(result => {
                        expect(result.from).to.be.eq(alice.evmAddress.toLowerCase());
                        expect(result.to).to.be.eq(erc721PointerContract.target.toLowerCase());
                    })
                }
            });
        });

        const evmBlockEndpoints = ['eth_getBlockByHash', 'eth_getBlockByNumber'];
        evmBlockEndpoints.forEach(endpoint => {
            it(`Evm log information matches with evm block information with ${endpoint}`, async () => {
                const blockResult = await rpcClient.checkAndReturnRpcResultsForBlock(evmAndCosmosBlockHeight - 2, evmAndCosmosBlockHeight, endpoint, '', topic);
                console.log(blockResult);
                blockResult.forEach(result => {
                    expect(result.blockNumber).to.be.eq(transactionIndexes[result.hash].blockNumber);
                    expect(result.transactionIndex).to.be.eq(transactionIndexes[result.hash].transactionIndex);
                    expect(result.blockHash).to.be.eq(transactionIndexes[result.hash].blockHash);
                    expect(result.from).to.be.eq(transactionIndexes[result.hash].from.toLowerCase());
                    expect(result.to).to.be.eq(transactionIndexes[result.hash].to.toLowerCase());
                })
            });
        });

        let debugBlockResults: any[];
        let traceOptions: object;
        it('Given that there are txs on evm side, debug trace block returns all txs', async () => {
            traceOptions = {
                disableStorage: true,    // Disable storage capture (default: false)
                disableStack: true,      // Disable stack capture (default: false)
                enableMemory: true,      // Enable memory capture (default: false)
                enableReturnData: true,  // Enable return data capture (default: false)
                timeout: "50s",           // Timeout for execution (e.g., "10s")
                tracer: "callTracer",     // Name of the tracer to use (e.g., "callTracer", "prestateTracer")
                tracerConfig: {           // Configuration for the selected tracer
                    onlyTopCall: false,  // Only collect tracing for top-level calls
                    withLog: true      // Include log output in the trace
                }
            }

            debugBlockResults = await rpcClient.debugTraceByBlockNumber(ethers.toQuantity(evmAndCosmosBlockHeight), traceOptions);
            expect(debugBlockResults.length).to.be.eq(1);
        });

        it('Debug trace results matches with eth_getTransactionByHash call', async () => {
            const ethResponse = await rpcClient.getTransactionByHash(debugBlockResults[0].txHash);
            expect(debugBlockResults[0].txHash).to.be.eq(ethResponse.hash);
            expect(debugBlockResults[0].result.from).to.be.eq(ethResponse.from);
            expect(debugBlockResults[0].result.to).to.be.eq(ethResponse.to);
            expect(debugBlockResults[0].result.gas).to.be.eq(ethResponse.gas);
            expect(debugBlockResults[0].result.input).to.be.eq(ethResponse.input);
        });

        it('Debug trace results matches with eth_getTransactionReceipt call', async () => {
            const ethResponse = await rpcClient.getTransactionReceipt(debugBlockResults[0].txHash);
            expect(debugBlockResults[0].txHash).to.be.eq(ethResponse.transactionHash);
            expect(debugBlockResults[0].result.from).to.be.eq(ethResponse.from);
            expect(debugBlockResults[0].result.to).to.be.eq(ethResponse.to);
            expect(debugBlockResults[0].result.gasUsed).to.be.eq(ethResponse.gasUsed);
        });

        it('Can debug trace transaction', async () =>{
            const debugResult = await rpcClient.debugTraceTransaction(debugBlockResults[0].txHash, traceOptions);
            expect(debugBlockResults[0].result.from).to.be.eq(debugResult.from);
            expect(debugBlockResults[0].result.to).to.be.eq(debugResult.to);
            expect(debugBlockResults[0].result.gasUsed).to.be.eq(debugResult.gasUsed);
            expect(debugBlockResults[0].result.gas).to.be.eq(debugResult.gas);
            expect(debugBlockResults[0].result.input).to.be.eq(debugResult.input);
        });

        it('Debug trace returns correct information with eth_getBlockReceipts', async () => {
            const ethResponse = await rpcClient.getBlockReceipts(ethers.toQuantity(evmAndCosmosBlockHeight));
            expect(debugBlockResults[0].txHash).to.be.eq(ethResponse[0].transactionHash);
            expect(debugBlockResults[0].result.from).to.be.eq(ethResponse[0].from);
            expect(debugBlockResults[0].result.to).to.be.eq(ethResponse[0].to);
            expect(debugBlockResults[0].result.gasUsed).to.be.eq(ethResponse[0].gasUsed);
        });
    });
});

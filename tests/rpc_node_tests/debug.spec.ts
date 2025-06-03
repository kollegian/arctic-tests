import contractAddresses from './contractAddresses.json';
import {SeiUser, UserFactory} from "../../shared/User";
import {Erc20Token} from "../../shared/Token";
import { DebugContract } from '../../typechain-types';
import * as testConfig from '../../config/testConfig.json';
import DebugContractAbi from '../../artifacts/contracts/DebugContract.sol/DebugContract.json';
import {EvmRpcClient} from "../../shared/RpcClient";
import {Block, ethers} from "ethers";
import {expect} from 'chai';


describe('Sei debug tests', function() {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let erc20: Erc20Token;
    let debugContract: DebugContract;
    let provider: ethers.JsonRpcProvider;
    let callData: string;
    let actualCall: string;
    let rpcClient: EvmRpcClient;

    before('Initializes', async () => {
        admin = await UserFactory.createAdminUser(testConfig);
        users = await UserFactory.createSeiUsers(admin, 40, true);
        erc20 = new Erc20Token(admin, contractAddresses.erc20);
        debugContract = new ethers.Contract(contractAddresses.debugAddress, DebugContractAbi.abi, admin.evmWallet.wallet) as unknown as DebugContract;
        rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
        callData = erc20.contract.interface.encodeFunctionData('mint', [users[1].evmAddress, ethers.parseEther('1')]);
        actualCall = debugContract.interface.encodeFunctionData('lowLevelCall', [erc20.getAddress(), callData]);
        provider = admin.evmWallet.signingClient;
    });

    describe('Tests debug_traceCall', function(){
        it.only('Debug call trace succeeds in valid block with default params', async () =>{
            const validBlockNumber = await rpcClient.getBlockByNumber('finalized') as Block;
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    gas: ethers.toQuantity(100000),
                    value: '0x0',
                    data: actualCall
                },
                ethers.toQuantity(validBlockNumber.number),
            ]
            const debugResult = await admin.evmWallet.signingClient.send('debug_traceCall', callParams);
            expect(debugResult.failed).to.be.false;
            expect(debugResult.gas).to.be.gt(25000);
            expect(debugResult.structLogs).to.have.length.gt(2);
        });

        it.only('Debug trace call with unexisting block number fails', async () => {
            const validBlockNumber = await rpcClient.getBlockByNumber('finalized') as Block;
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    gas: ethers.toQuantity(100000),
                    value: '0x0',
                    data: actualCall
                },
                ethers.toQuantity(validBlockNumber.number + 500),
            ]
            const debugResult = await admin.evmWallet.signingClient.send('debug_traceCall', callParams);
            console.log(debugResult);
            expect(debugResult.failed).to.be.false;
            expect(debugResult.gas).to.be.gt(25000);
            expect(debugResult.structLogs).to.have.length.gt(2);
        })

        it('Debug trace call succeeds in gas price fluctuations with default setting', async () => {
            const receipts = await erc20.sendMultipleTxs(users);
            const block = receipts[0].blockNumber;
            const callData = erc20.contract.interface.encodeFunctionData('mint', [admin.evmAddress, ethers.parseEther('10')]);
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: erc20.getAddress(),
                    gas: ethers.toQuantity(100000),
                    value: '0x0',
                    data: callData
                },
                ethers.toQuantity(block + 1),
            ]
            const debugResult = await admin.evmWallet.signingClient.send('debug_traceCall', callParams);
            expect(debugResult.failed).to.be.false;
            expect(debugResult.gas).to.be.gt(25000);
            expect(debugResult.structLogs).to.have.length.gt(2);
        });

        it('Debug trace call succeeds if provided block hash with default setting', async () =>{
            const validBlockNumber = await admin.evmWallet.signingClient.getBlock('finalized') as Block;
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    gasPrice: ethers.toQuantity(1000000),
                    value: '0x0',
                    data: actualCall
                },
                validBlockNumber.hash,
            ]
            const debugResult = await admin.evmWallet.signingClient.send('debug_traceCall', callParams);
            expect(debugResult.failed).to.be.false;
            expect(debugResult.gas).to.be.gt(25000);
            expect(debugResult.structLogs).to.have.length.gt(10);
        });

        it('Debug trace call fails with not existing hash', async () =>{
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    gasPrice: ethers.toQuantity(1000000),
                    value: '0x0',
                    data: actualCall
                },
                '0x0000000000000000000000000000000000000000000000000000000000000000',
            ]
            const debugResult = await admin.evmWallet.signingClient.send('debug_traceCall', callParams);
            console.log(debugResult);
        });

        it('Debug trace call returns valid information about failing txs with default setting', async () => {
            const callData = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('1000000')]);
            const actualCall = debugContract.interface.encodeFunctionData('lowLevelCall', [erc20.getAddress(), callData]);
            const validBlockNumber = await provider.getBlock('finalized') as Block;

            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    gasPrice: ethers.toQuantity(100000),
                    value: '0x0',
                    data: actualCall
                },
                validBlockNumber.hash,
            ]
            const debugResult = await provider.send('debug_traceCall', callParams);
            expect(debugResult.failed).to.be.true;
            expect(debugResult.returnValue).to.be.eq('');
            expect(debugResult.structLogs).to.have.length.gt(10);
            expect(debugResult.gas).to.be.gt(25000);
        });

        it('Debug trace call returns only top call with block number', async () => {
            const callData = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('1')]);
            const actualCall = debugContract.interface.encodeFunctionData('lowLevelCall', [erc20.getAddress(), callData]);
            const validBlockNumber = await provider.getBlock('finalized') as Block;

            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    gasPrice: ethers.toQuantity(100000),
                    value: '0x0',
                    data: actualCall
                },
                validBlockNumber.hash,
                {
                    tracer: 'callTracer',
                    onlyTopCall: true
                }
            ]
            const debugResult = await provider.send('debug_traceCall', callParams);
            expect(debugResult.from.toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
            expect(debugResult.to.toLowerCase()).to.be.eq((await debugContract.getAddress()).toLowerCase());
            expect(parseInt(debugResult.gas)).to.be.gt(25000);
            expect(debugResult.type).to.be.eq('CALL');
        });

        const tags = ['finalized', 'safe', 'earliest'];
        for(const tag of tags) {
            it(`Can call debug_traceCall with block tag ${tag}`, async () => {
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
                        gasPrice: ethers.toQuantity(100000),
                        value: '0x0',
                        data: actualCall
                    },
                    tag,
                ]
                const debugResult = await provider.send('debug_traceCall', callParams);
                expect(debugResult.failed).to.be.false;
                expect(debugResult.gas).to.be.gt(25000);
                expect(debugResult.structLogs).to.have.length.gt(10);
            });

            it(`Can use tracer config with block tag ${tag}`, async () => {
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
                        gasPrice: ethers.toQuantity(100000),
                        value: '0x0',
                        data: actualCall
                    },
                    tag,
                    {
                        tracer: 'callTracer'
                    }
                ];
                const debugResult = await provider.send('debug_traceCall', callParams);
                expect(debugResult.from.toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
                expect(debugResult.to.toLowerCase()).to.be.eq((await debugContract.getAddress()).toLowerCase());
                expect(parseInt(debugResult.gas)).to.be.gt(25000);
                expect(debugResult.type).to.be.eq('CALL');            });

            it(`Can use pre state tracer with block tag ${tag}`, async () => {
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
                        gasPrice: ethers.toQuantity(100000),
                        value: '0x0',
                        data: actualCall
                    },
                    tag,
                    {
                        tracer: 'prestateTracer'
                    }
                ];
                const debugResult = await provider.send('debug_traceCall', callParams);
                expect(debugResult[admin.evmAddress.toLowerCase()]['balance']).to.be
                    .eq(ethers.toQuantity(await admin.evmWallet.queryBalance()));
                expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractArtifacts.deployedBytecode)
            });

            it(`Can use call tracer with block tag ${tag} with only top call`, async () => {
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
                        gasPrice: ethers.toQuantity(100000),
                        value: '0x0',
                        data: actualCall
                    },
                    tag,
                    {
                        tracer: 'callTracer',
                        onlyTopCall: false
                    }
                ];
                const debugResult = await provider.send('debug_traceCall', callParams);
                expect(debugResult.from.toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
                expect(debugResult.to.toLowerCase()).to.be.eq((await debugContract.getAddress()).toLowerCase());
                expect(parseInt(debugResult.gas)).to.be.gt(25000);
                expect(debugResult.type).to.be.eq('CALL');
            });

            it(`Can use with only top call true with call tracer with tag ${tag}`, async () => {
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
                        gasPrice: ethers.toQuantity(100000),
                        value: '0x0',
                        data: actualCall
                    },
                    tag,
                    {
                        tracer: 'callTracer',
                        onlyTopCall: true
                    }
                ];
                const debugResult = await provider.send('debug_traceCall', callParams);
                expect(debugResult.from.toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
                expect(debugResult.to.toLowerCase()).to.be.eq((await debugContract.getAddress()).toLowerCase());
                expect(parseInt(debugResult.gas)).to.be.gt(25000);
                expect(debugResult.type).to.be.eq('CALL');
            })
        }

        const tracerConfigs = ['prestateTracer', 'callTracer'];
        const topCallConfigs = [true, false];
        for(const tracer of tracerConfigs) {
            it(`Users can call ${tracer} to check state with debug call with blockhash with passing tx`, async () => {
                const validBlockNumber = await provider.getBlock('finalized') as Block;
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
                        gasPrice: ethers.toQuantity(100000),
                        value: '0x0',
                        data: actualCall
                    },
                    validBlockNumber.hash,
                    {
                        "tracer": tracer
                    }
                ]
                const debugResult = await provider.send('debug_traceCall', callParams);
                if(tracer === 'prestateTracer') {
                    expect(debugResult[admin.evmAddress.toLowerCase()]['balance']).to.be
                        .eq(ethers.toQuantity(await admin.evmWallet.queryBalance()));
                    expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractArtifacts.deployedBytecode)
                }
                if(tracer === 'callTracer') {
                    expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].to).to.be.eq(erc20.contractAddress.toLowerCase());
                    expect(debugResult['calls'][0].value).to.be.eq('0x0');
                }
            });

            it(`Users can call ${tracer} to check state with debug call block number`, async () => {
                const validBlockNumber = await provider.getBlock('finalized') as Block;
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
                        gasPrice: ethers.toQuantity(100000),
                        value: '0x0',
                        data: actualCall
                    },
                    ethers.toQuantity(validBlockNumber.number),
                    {
                        "tracer": tracer
                    }
                ]
                const debugResult = await provider.send('debug_traceCall', callParams);
                if(tracer === 'prestateTracer') {
                    expect(debugResult[admin.evmAddress.toLowerCase()]['balance']).to.be
                        .eq(ethers.toQuantity(await admin.evmWallet.queryBalance()));
                    expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractArtifacts.deployedBytecode)
                }
                if(tracer === 'callTracer') {
                    expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].to).to.be.eq(erc20.contractAddress.toLowerCase());
                    expect(debugResult['calls'][0].value).to.be.eq('0x0');
                }
            });

            for(const topCallConfig of topCallConfigs) {
                it(`Users can call ${tracer} to check state with debug call with blockhash with passing tx with topCall ${topCallConfig}`, async () => {
                    const validBlockNumber = await provider.getBlock('finalized') as Block;
                    const callParams = [
                        {
                            from: admin.evmAddress,
                            to: await debugContract.getAddress(),
                            gasPrice: ethers.toQuantity(100000),
                            value: '0x0',
                            data: actualCall
                        },
                        validBlockNumber.hash,
                        {
                            "tracer": tracer,
                            "onlyTopCall": topCallConfig,
                        }
                    ]
                    const debugResult = await provider.send('debug_traceCall', callParams);
                    if(tracer === 'prestateTracer') {
                        expect(debugResult[admin.evmAddress.toLowerCase()]['balance']).to.be
                            .eq(ethers.toQuantity(await admin.evmWallet.queryBalance()));
                        expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractArtifacts.deployedBytecode)
                    }
                    if(tracer === 'callTracer') {
                        expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                        expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.contractAddress.toLowerCase());
                        expect(debugResult['calls'][0].value).to.be.eq('0x0');
                    }
                });

                it(`Users can call ${tracer} to check state with debug call block number with top call ${topCallConfig}`, async () => {
                    const validBlockNumber = await provider.getBlock('finalized') as Block;
                    const callParams = [
                        {
                            from: admin.evmAddress,
                            to: await debugContract.getAddress(),
                            gasPrice: ethers.toQuantity(100000),
                            value: '0x0',
                            data: actualCall
                        },
                        ethers.toQuantity(validBlockNumber.number),
                        {
                            "tracer": tracer,
                            "onlyTopCall": topCallConfig
                        }
                    ]
                    const debugResult = await provider.send('debug_traceCall', callParams);
                    if(tracer === 'prestateTracer') {
                        expect(debugResult[admin.evmAddress.toLowerCase()]['balance']).to.be
                            .eq(ethers.toQuantity(await admin.evmWallet.queryBalance()));
                        expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractArtifacts.deployedBytecode)
                    }
                    if(tracer === 'callTracer') {
                        expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                        expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.contractAddress.toLowerCase());
                        expect(debugResult['calls'][0].value).to.be.eq('0x0');
                    }
                });
            }
        }
    });

    describe('Tests debug_traceTransaction', function(){
        let txHash: string;
        let failingTXHash: string;

        before('Sends tx', async () => {
            const callData = erc20.contract.interface.encodeFunctionData('mint', [users[1].evmAddress, ethers.parseEther('1')]);
            const tx = await (await debugContract.lowLevelCall(erc20.contractAddress, callData)).wait();
            txHash = tx.hash;
        });

        it('Can trace transaction with default parameters', async () => {
            const params = [
                txHash
            ]
            const debugResult = await provider.send('debug_traceTransaction', params);
            expect(debugResult.failed).to.be.false;
            expect(debugResult.gas).to.be.above(10000);
            expect(debugResult.structLogs).to.have.length.gt(10);
        });

        it('Can get failing tx transactions', async () => {
            const callData = erc20.contract.interface.encodeFunctionData('transfer', [users[1].evmAddress, ethers.parseEther('1')]);
            try{
                const tx = await (await debugContract.lowLevelCall(erc20.contractAddress, callData, {gasLimit: 100000})).wait();
            } catch(e){
                failingTXHash = e.receipt.hash;
            }
            const params = [
                failingTXHash
            ]
            const debugResult = await provider.send('debug_traceTransaction', params);
            expect(debugResult.failed).to.be.true;
            expect(debugResult.gas).to.be.above(10000);
            expect(debugResult.structLogs).to.have.length.gt(10);
        });

        const tracerConfigs = ['prestateTracer', 'callTracer'];
        const topCallConfigs = [true, false];
        for(const tracerConfig of tracerConfigs) {

            it(`Can see debug trace transaction with ${tracerConfig} for successful tx`, async () => {
                const params = [
                    txHash,
                    {
                        tracer: tracerConfig,
                    }
                ]
                const debugResult = await provider.send('debug_traceTransaction', params);
                if(tracerConfig === 'prestateTracer') {
                    expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractArtifacts.deployedBytecode)
                }
                if(tracerConfig === 'callTracer') {
                    expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].to).to.be.eq(erc20.contractAddress.toLowerCase());
                    expect(debugResult['calls'][0].value).to.be.eq('0x0');
                }
            });

            it(`Can see debug trace transacttion with ${tracerConfig} for failing tx`, async () => {
                const params = [
                    failingTXHash,
                    {
                        tracer: tracerConfig,
                    }
                ]
                const debugResult = await provider.send('debug_traceTransaction', params);
                if(tracerConfig === 'prestateTracer') {
                    expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractArtifacts.deployedBytecode)
                }
                if(tracerConfig === 'callTracer') {
                    expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].to).to.be.eq(erc20.contractAddress.toLowerCase());
                    expect(debugResult['calls'][0].value).to.be.eq('0x0');
                    expect(debugResult['error']).to.be.eq('execution reverted');
                    expect(debugResult['revertReason']).to.be.eq('Call failed');
                }
            });
            for(const topCallConfig of topCallConfigs) {
                it(`Can see debug trace transaction with ${tracerConfig} for successful tx with top call ${topCallConfig}`, async () => {
                    const params = [
                        txHash,
                        {
                            tracer: tracerConfig,
                            onlyTopCall: topCallConfig,
                        }
                    ]
                    const debugResult = await provider.send('debug_traceTransaction', params);
                    if(tracerConfig === 'prestateTracer') {
                        expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractArtifacts.deployedBytecode)
                    }
                    if(tracerConfig === 'callTracer') {
                        expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                        expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.contractAddress.toLowerCase());
                        expect(debugResult['calls'][0].value).to.be.eq('0x0');
                    }
                });

                it(`Can see debug trace transaction with ${tracerConfig} for failing tx with top call ${topCallConfig}`, async () => {
                    const params = [
                        failingTXHash,
                        {
                            tracer: tracerConfig,
                            onlyTopCall: topCallConfig,
                        }
                    ]
                    const debugResult = await provider.send('debug_traceTransaction', params);
                    if(tracerConfig === 'prestateTracer') {
                        expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractArtifacts.deployedBytecode)
                    }
                    if(tracerConfig === 'callTracer') {
                        expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                        expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.contractAddress.toLowerCase());
                        expect(debugResult['calls'][0].value).to.be.eq('0x0');
                        expect(debugResult['error']).to.be.eq('execution reverted');
                        expect(debugResult['revertReason']).to.be.eq('Call failed');
                    }
                })
            }
        }
    });

    describe('Tests debug_traceBlockByNumber and blockByHash', function(){
        let blockNumber: Uint8Array | ethers.BlockTag;
        let blockHash: string;

        it('Debugs block with 10 txs in it - block number', async () =>{
            const txs = [];
            for (let i = 0; i<10; i++){
                txs.push(erc20.contract.connect(users[i].evmWallet.wallet).transfer(users[i + 1].evmAddress, ethers.parseEther('0.1')));
            }
            const txPromises = await Promise.all(txs);
            console.log('Txs sent');
            const receipts = await Promise.all(txPromises.map((receipt) => receipt.wait()));
            console.log('Receipts received');
            blockNumber = receipts[2]!.blockNumber;
            blockHash = (await provider.getBlock(blockNumber))!.hash as string;
            const params = [
                ethers.toQuantity(blockNumber),
            ];
            const debugResult = await provider.send('debug_traceBlockByNumber', params);
            console.log(debugResult);
            expect(debugResult.length).to.be.gt(2);
        });

        it('Debugs block with 10 txs in it -  block hash', async () =>{
            const params = [
                blockHash,
            ];
            const debugResult = await provider.send('debug_traceBlockByHash', params);
            expect(debugResult.length).to.be.gt(2);
        });

        const tracerConfigs = ['prestateTracer', 'callTracer'];
        const topCallConfigs = [true, false];
        for(const tracerConfig of tracerConfigs) {
            it(`Queries block with hash with ${tracerConfig}`, async () =>{
                const params = [
                    blockHash,
                    {
                        tracer: tracerConfig,
                    }
                ];
                const debugResult = await provider.send('debug_traceBlockByHash', params);
                expect(debugResult.length).to.be.gt(2);
            });

            it(`Queries block with number ${tracerConfig}`, async () =>{
                const params = [
                    ethers.toQuantity(blockNumber),
                    {
                        tracer: tracerConfig,
                    }
                ];
                const debugResult = await provider.send('debug_traceBlockByNumber', params);
                expect(debugResult.length).to.be.gt(2);
            });
            for(const topCallConfig of topCallConfigs) {
                it(`Queries block with number ${tracerConfig} with ${topCallConfig}`, async () =>{
                    const params = [
                        ethers.toQuantity(blockNumber),
                        {
                            tracer: tracerConfig,
                            onlyTopCall: topCallConfig,
                        }
                    ];
                    const debugResult = await provider.send('debug_traceBlockByNumber', params);
                    expect(debugResult.length).to.be.gt(2);
                });

                it(`Queries block with hash ${tracerConfig} with ${topCallConfig}`, async () =>{
                    const params = [
                        blockHash,
                        {
                            tracer: tracerConfig,
                            onlyTopCall: topCallConfig,
                        }
                    ];
                    const debugResult = await provider.send('debug_traceBlockByHash', params);
                    expect(debugResult.length).to.be.gt(2);
                })
            }
        }
    });
})

import contractAddresses from './contractAddresses.json';
import {SeiUser, UserFactory} from "../../shared/User";
import {Erc20Token} from "../../shared/Token";
import { DebugContract } from '../../typechain-types';
import * as testConfig from '../../config/testConfig.json';
import DebugContractAbi from '../../artifacts/contracts/DebugContract.sol/DebugContract.json';
import {EvmRpcClient} from "../../shared/RpcClient";
import {Block, ethers} from "ethers";
import {expect} from 'chai';
import _ from "lodash";

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
        admin = await UserFactory.createAdminUser();
        users = await UserFactory.createSeiUsers(admin, 5, true);
        erc20 = new Erc20Token(admin, contractAddresses.erc20);
        debugContract = new ethers.Contract(contractAddresses.debugAddress, DebugContractAbi.abi, admin.evmWallet.wallet) as unknown as DebugContract;
        rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
        callData = erc20.contract.interface.encodeFunctionData('mint', [users[1].evmAddress, ethers.parseEther('1')]);
        actualCall = debugContract.interface.encodeFunctionData('lowLevelCall', [erc20.getAddress(), callData]);
        provider = admin.evmWallet.signingClient;
    });

    function printDebugTraceCallCurl(
        from: string,
        to: string,
        data: string,
        blockNumber: number | string,
        rpcEndpoint: string,
        maxFeePerGas: string,
        options?: any
    ): void {
        // Convert block number to hex if it's a number
        const blockParam = typeof blockNumber === 'number'
            ? ethers.toQuantity(blockNumber)
            : blockNumber;

        // Create the call parameters
        const callParams = [
            {
                from,
                to,
                maxFeePerGas,
                data
            },
            blockParam
        ];

        // Add options as the third parameter if provided
        if (options) {
            callParams.push(options);
        }

        // Create the JSON-RPC request body
        const requestBody = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "debug_traceCall",
            params: callParams
        }, null, 2);

        // Format the curl command
        const curlCommand = `curl -X POST \\
  -H "Content-Type: application/json" \\
  --data '${requestBody}' \\
  ${rpcEndpoint}`;

        console.log(curlCommand);
    }


    describe('Tests debug_traceCall', function(){
        it.only('Debug call trace succeeds in valid block with default params', async () =>{
            const validBlockNumber = await rpcClient.getBlockByNumber('finalized') as Block;
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    // gas: ethers.toQuantity(100000),
                    maxFeePerGas: ethers.toQuantity(1000000000),
                    // value: '0x0',
                    data: actualCall
                },
                ethers.toQuantity(validBlockNumber.number),
            ]
            printDebugTraceCallCurl(admin.evmAddress, await debugContract.getAddress(), actualCall, validBlockNumber.number, 'http://18.117.219.102:8545', ethers.toQuantity(1000000000));
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
            try{
                const debugResult = await admin.evmWallet.signingClient.send('debug_traceCall', callParams);
                throw new Error('Should have failed');
            } catch (e: any){
                expect(e.message).to.contain("height must be less than or equal to the head of the node's blockchain");
            }
        })

        it.only('Debug trace call succeeds in gas price fluctuations with default setting', async () => {
            const receipts = await erc20.sendMultipleTxs(users);
            const block = receipts[0].blockNumber;
            const callData = erc20.contract.interface.encodeFunctionData('mint', [admin.evmAddress, ethers.parseEther('10')]);
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: erc20.getAddress(),
                    gas: ethers.toQuantity(100000),
                    maxFeePerGas: ethers.toQuantity(1000000000),
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

        it.only('Debug trace call succeeds if provided block hash with default setting', async () =>{
            const validBlockNumber = await admin.evmWallet.signingClient.getBlock('finalized') as Block;
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    gas: ethers.toQuantity(1000000),
                    maxFeePerGas: ethers.toQuantity(1000000000),
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

        it.only('Debug trace call fails with not existing hash', async () =>{
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    gasPrice: ethers.toQuantity(1000000),
                    maxFeePerGas: ethers.toQuantity(1000000000),
                    value: '0x0',
                    data: actualCall
                },
                '0x0000000000000000000000000000000000000000000000000000000000000000',
            ]
            try{
                await admin.evmWallet.signingClient.send('debug_traceCall', callParams);
                throw new Error('Should have failed');
            } catch(e: any){
                expect(e.message).to.contain('could not find block for hash');
            }
        });

        it.only('Debug trace call returns valid information about failing txs with default setting', async () => {
            const callData = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('1000000')]);
            const actualCall = debugContract.interface.encodeFunctionData('lowLevelCall', [erc20.getAddress(), callData]);
            const validBlockNumber = await provider.getBlock('finalized') as Block;

            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    gasPrice: ethers.toQuantity(100000),
                    maxFeePerGas: ethers.toQuantity(1000000000),
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

        it.only('Debug trace call returns only top call with block number', async () => {
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

        //@todo add earliest again
        const tags = ['finalized', 'safe'];
        for(const tag of tags) {
            it.only(`Can call debug_traceCall with block tag ${tag}`, async () => {
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

            it.only(`Can use tracer config with block tag ${tag}`, async () => {
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

            it.only(`Can use pre state tracer with block tag ${tag}`, async () => {
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
                const ercContractData = debugResult[erc20.getAddress().toLowerCase()]['storage'];
                expect(debugResult[admin.evmAddress.toLowerCase()]['balance']).to.be
                    .eq(ethers.toQuantity(await admin.evmWallet.queryBalance()));
                expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                Object.entries(ercContractData).map( async ([storage, value]) => {
                    const queriedStorage = await provider.getStorage(erc20.getAddress(), storage);
                    expect(queriedStorage).to.be.eq(value);
                });
            });

            it.only(`Can use call tracer with block tag ${tag} with only top call`, async () => {
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

            it.only(`Can use with only top call true with call tracer with tag ${tag}`, async () => {
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

        it.only('Debug trace call prestate tracer updates with data changes', async () =>{
            const tx = await erc20.mint(admin.evmAddress, ethers.parseEther('100').toString());
            await tx.wait();
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    gasPrice: ethers.toQuantity(100000),
                    value: '0x0',
                    data: actualCall
                },
                'finalized',
                {
                    tracer: 'prestateTracer',
                    onlyTopCall: true
                }
            ];
            const debugResult = await provider.send('debug_traceCall', callParams);
            const ercContractData = debugResult[erc20.getAddress().toLowerCase()]['storage'];
            expect(debugResult[admin.evmAddress.toLowerCase()]['balance']).to.be
                .eq(ethers.toQuantity(await admin.evmWallet.queryBalance()));
            expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
            Object.entries(ercContractData).map( async ([storage, value]) => {
                const queriedStorage = await provider.getStorage(erc20.getAddress(), storage);
                expect(queriedStorage).to.be.eq(value);
            });

        });

        const tracerConfigs = ['prestateTracer', 'callTracer'];
        const topCallConfigs = [true, false];
        for(const tracer of tracerConfigs) {
            it.only(`Users can call ${tracer} to check state with debug call with blockhash with passing tx`, async () => {
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
                    expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                }
                if(tracer === 'callTracer') {
                    expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                    expect(debugResult['calls'][0].value).to.be.eq('0x0');
                }
            });

            it.only(`Users can call ${tracer} to check state with debug call block number`, async () => {
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
                    expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                }
                if(tracer === 'callTracer') {
                    expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                    expect(debugResult['calls'][0].value).to.be.eq('0x0');
                }
            });

            for(const topCallConfig of topCallConfigs) {
                it.only(`Users can call ${tracer} to check state with debug call with blockhash with passing tx with topCall ${topCallConfig}`, async () => {
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
                        expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                    }
                    if(tracer === 'callTracer') {
                        expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                        expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                        expect(debugResult['calls'][0].value).to.be.eq('0x0');
                    }
                });

                it.only(`Users can call ${tracer} to check state with debug call block number with top call ${topCallConfig}`, async () => {
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
                        expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                    }
                    if(tracer === 'callTracer') {
                        expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                        expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                        expect(debugResult['calls'][0].value).to.be.eq('0x0');
                    }
                });
            }
        }
    });

    describe('Tests debug_traceTransaction', function(){
        let txHash: string;
        let failingTXHash: string;
        let preBalance: bigint;

        before('Sends tx', async () => {
            preBalance = await admin.evmWallet.queryBalance();
            const callData = erc20.contract.interface.encodeFunctionData('mint', [users[1].evmAddress, ethers.parseEther('1')]);
            const tx = await (await debugContract.connect(admin.evmWallet.wallet).lowLevelCall(erc20.getAddress(), callData)).wait();
            console.log(tx);
            txHash = tx.hash;
            console.log('Erc contract address is ', erc20.getAddress());
            console.log('Debug contract address is ', await debugContract.getAddress());
            console.log('Receiver address is ', users[1].evmAddress);
            console.log('Sender address is ', admin.evmAddress);
        });

        it.only('Can trace transaction with default parameters', async () => {
            const params = [
                txHash
            ]
            const debugResult = await provider.send('debug_traceTransaction', params);
            expect(debugResult.failed).to.be.false;
            expect(debugResult.gas).to.be.above(10000);
            expect(debugResult.structLogs).to.have.length.gt(10);
        });

        it.only('Trace transaction with default parameters match with eth get block Receipt', async () =>{
            const rpcCall = await rpcClient.getTransactionReceipt(txHash);
            const params = [
                txHash
            ]
            const debugResult = await provider.send('debug_traceTransaction', params);
            expect(ethers.toNumber(rpcCall.gasUsed)).to.be.eq(debugResult.gas);
        });

        it.only('Trace transaction data is consistent with transaction receipt call with diff mode on', async () =>{
            const params = [
                txHash,
                {
                    tracer: 'prestateTracer',
                    tracerConfig: {
                        diffMode: true,
                        onlyTopCall: true
                    }
                }
            ]
            const debugResult = await provider.send('debug_traceTransaction', params);
            console.log(ethers.formatEther(debugResult['post'][admin.evmAddress.toLowerCase()]['balance']));
            console.log('-----');
            console.log(ethers.formatEther(await admin.evmWallet.queryBalance()));
            console.log('Pre balances ');
            console.log(ethers.formatEther(debugResult['pre'][admin.evmAddress.toLowerCase()]['balance']));
            console.log(ethers.formatEther(preBalance.toString()));
            const balanceDiff = BigInt(debugResult['pre'][admin.evmAddress.toLowerCase()]['balance']) - BigInt(debugResult['post'][admin.evmAddress.toLowerCase()]['balance']);
            console.log(ethers.formatEther(balanceDiff));

            const receipt = await rpcClient.getTransactionReceipt(txHash);
            const gasPaid = (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice));
            console.log('Paid gas is ', ethers.formatEther(gasPaid));

            const afterBalance = await admin.evmWallet.queryBalance();
            console.log('Actual balance diff ', ethers.formatEther((preBalance - afterBalance).toString()));
        });

        it.only('Debug trace transaction returns valid info on valid txs with prestate tracer and diff mode false', async () =>{
            const params = [
                txHash,
                {
                    tracer: 'prestateTracer',
                }
            ]
            const debugResult = await provider.send('debug_traceTransaction', params);
            console.log('Balance now is ', ethers.formatEther(debugResult[admin.evmAddress.toLowerCase()]['balance']));
            console.log('Balance  actual is ', ethers.formatEther(await admin.evmWallet.queryBalance()));

            const params2 = [
                txHash,
                {
                    tracer: 'prestateTracer',
                    tracerConfig: {
                        diffMode: true,
                        onlyTopCall: false
                    }
                }
            ]
            const debugResult2 = await provider.send('debug_traceTransaction', params2);
            console.log(ethers.formatEther(debugResult2['post'][admin.evmAddress.toLowerCase()]['balance']));
        });

        it.only('Can get failing tx transactions', async () => {
            const callData = erc20.contract.interface.encodeFunctionData('transfer', [users[1].evmAddress, ethers.parseEther('1')]);
            try{
                const tx = await (await debugContract.lowLevelCall(erc20.getAddress(), callData, {gasLimit: 100000})).wait();
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
            it.only(`Can see debug trace transaction with ${tracerConfig} for successful tx`, async () => {
                const params = [
                    txHash,
                    {
                        tracer: tracerConfig,
                    }
                ]
                const debugResult = await provider.send('debug_traceTransaction', params);
                if(tracerConfig === 'prestateTracer') {
                    expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                }
                if(tracerConfig === 'callTracer') {
                    expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                    expect(debugResult['calls'][0].value).to.be.eq('0x0');
                }
            });

            it.only(`Can see debug trace transaction with ${tracerConfig} for failing tx`, async () => {
                const params = [
                    failingTXHash,
                    {
                        tracer: tracerConfig,
                    }
                ]
                const debugResult = await provider.send('debug_traceTransaction', params);
                if(tracerConfig === 'prestateTracer') {
                    expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                }
                if(tracerConfig === 'callTracer') {
                    expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                    expect(debugResult['calls'][0].value).to.be.eq('0x0');
                    expect(debugResult['error']).to.be.eq('execution reverted');
                    expect(debugResult['revertReason']).to.be.eq('Call failed');
                }
            });
            for(const topCallConfig of topCallConfigs) {
                it.only(`Can see debug trace transaction with ${tracerConfig} for successful tx with top call ${topCallConfig}`, async () => {
                    const params = [
                        txHash,
                        {
                            tracer: tracerConfig,
                            onlyTopCall: topCallConfig,
                        }
                    ]
                    const debugResult = await provider.send('debug_traceTransaction', params);
                    if(tracerConfig === 'prestateTracer') {
                        expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                    }
                    if(tracerConfig === 'callTracer') {
                        expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                        expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                        expect(debugResult['calls'][0].value).to.be.eq('0x0');
                    }
                });

                it.only(`Can see debug trace transaction with ${tracerConfig} for failing tx with top call ${topCallConfig}`, async () => {
                    const params = [
                        failingTXHash,
                        {
                            tracer: tracerConfig,
                            onlyTopCall: topCallConfig,
                        }
                    ]
                    const debugResult = await provider.send('debug_traceTransaction', params);
                    if(tracerConfig === 'prestateTracer') {
                        expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                    }
                    if(tracerConfig === 'callTracer') {
                        expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                        expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
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

        let numberDebugResult: [];
        it.only('Debugs block with 40 txs in it - block number', async () => {
            const txs = [];
            for (let i = 0; i<4; i++) {
                txs.push(erc20.contract.connect(users[i].evmWallet.wallet).transfer(users[i + 1].evmAddress, ethers.parseEther('0.1')));
            }
            const txPromises = await Promise.all(txs);
            console.log('Txs sent');
            const receipts = await Promise.all(txPromises.map((receipt) => receipt.wait()));
            const blockNumbers = receipts.reduce((prev, curr) => {
                if (prev.has(curr.blockNumber)) {
                    prev.set(curr.blockNumber, prev.get(curr.blockNumber) + 1);
                } else {
                    prev.set(curr.blockNumber, 1);
                }
                return prev;
            }, new Map());
            blockNumber = receipts[2]!.blockNumber;
            blockHash = (await provider.getBlock(blockNumber))!.hash as string;
            const params = [
                ethers.toQuantity(blockNumber),
            ];
            numberDebugResult = await provider.send('debug_traceBlockByNumber', params);
            console.log('Number of txs in a single block is ', blockNumbers.get(blockNumber));
            expect(numberDebugResult.length).to.be.eq(blockNumbers.get(blockNumber));
        });

        let hashDebugResult: [];
        it.only('Debugs block with 40 txs in it -  block hash', async () =>{
            const params = [
                blockHash,
            ];
            hashDebugResult = await provider.send('debug_traceBlockByHash', params);
            console.log(hashDebugResult.length);
            expect(hashDebugResult.length).to.be.gt(2);
        });

        it.only('Debug trace block by number and debug trace by block hash returns same information', async () =>{
            expect(_.isEqual(numberDebugResult, hashDebugResult)).to.be.true;
        });

        const tracerConfigs = ['prestateTracer', 'callTracer'];
        const topCallConfigs = [true, false];
        for(const tracerConfig of tracerConfigs) {
            it.only(`Queries block with hash with ${tracerConfig}`, async () =>{
                const params = [
                    blockHash,
                    {
                        tracer: tracerConfig,
                    }
                ];
                const debugResult = await provider.send('debug_traceBlockByHash', params);
                expect(debugResult.length).to.be.gt(2);
            });

            it.only(`Queries block with number ${tracerConfig}`, async () =>{
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
                it.only(`Queries block with number ${tracerConfig} with ${topCallConfig}`, async () =>{
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

                it.only(`Queries block with hash ${tracerConfig} with ${topCallConfig}`, async () =>{
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

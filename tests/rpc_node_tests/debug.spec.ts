import contractAddresses from './contractAddresses.json';
import {SeiUser, UserFactory} from "../../shared/User";
import {Erc20Token} from "../../shared/Token";
import { DebugContract } from '../../typechain-types';
import DebugContractAbi from '../../artifacts/contracts/DebugContract.sol/DebugContract.json';
import {EvmRpcClient} from "../../shared/RpcClient";
import {Block, ethers} from "ethers";
import {expect} from 'chai';
import _ from "lodash";
import {waitFor} from "../../shared/utils/helpers";
import {unwrapErrorMessage} from "../../shared/utils/errors";

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
        users = await UserFactory.createSeiUsers(admin, 10, true);
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
        it('Debug call trace succeeds in valid block with default params', async () =>{
            // Step back 5 blocks from `finalized` to absorb RPC-pod state-prop
            // lag. If the first call resolves `finalized` against pod A and
            // the debug_traceCall hits pod B, pod B may not yet know about
            // the just-finalized block — error: "requested height N is not
            // yet available; safe latest is N-1: block height not yet
            // available". The test intent is "succeeds in a valid block";
            // any sufficiently-historical block satisfies it.
            const validBlockNumber = await rpcClient.getBlockByNumber('finalized') as Block;
            const traceBlock = Math.max(1, validBlockNumber.number - 5);
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    data: actualCall
                },
                ethers.toQuantity(traceBlock),
            ]
            const debugResult = await admin.evmWallet.signingClient.send('debug_traceCall', callParams);
            expect(debugResult.failed).to.be.false;
            expect(debugResult.gas).to.be.gt(25000);
            expect(debugResult.structLogs).to.have.length.gt(2);
            expect(debugResult).to.have.property('returnValue');

            const firstLog = debugResult.structLogs[0];
            expect(firstLog).to.have.property('op').that.is.a('string');
            expect(firstLog).to.have.property('pc').that.is.a('number');
            expect(firstLog).to.have.property('gas').that.is.a('number');
            expect(firstLog).to.have.property('gasCost').that.is.a('number');
            expect(firstLog).to.have.property('depth').that.is.a('number');
            expect(firstLog.depth).to.be.gte(1);
        });

        it('Debug trace call with unexisting block number fails', async () => {
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
                expect(e.message).to.contain("is not yet available; safe latest is");
            }
        })

        it('Debug trace call succeeds in gas price fluctuations with default setting', async () => {
            const balance = await erc20.balanceOf(users[1].evmAddress);
            const receipts = await erc20.sendMultipleTxs(users);
            const block = receipts[0].blockNumber;
            console.log('Block received');
            const callData = erc20.contract.interface.encodeFunctionData('mint', [admin.evmAddress, ethers.parseEther('10')]);
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: erc20.getAddress(),
                    //gas: ethers.toQuantity(100000),
                    //maxFeePerGas: ethers.toQuantity(1300000000),
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
                    //gas: ethers.toQuantity(1000000),
                    //maxFeePerGas: ethers.toQuantity(1000000000),
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
                // The chain's exact wording for block-hash-not-found varies
                // ("header not found" on geth-style, "could not find block for
                // hash" on older Sei builds). Assert intent — the error names
                // a missing block/header — rather than a specific phrasing.
                const msg = unwrapErrorMessage(e);
                expect(msg, `actual: ${msg}`).to.match(/could not find block for hash|header not found|block.*not found|hash.*not found/i);
            }
        });

        it('Debug trace call returns valid information about failing txs with default setting', async () => {
            const callData = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('1000000')]);
            const actualCall = debugContract.interface.encodeFunctionData('lowLevelCall', [erc20.getAddress(), callData]);
            const validBlockNumber = await provider.getBlock('finalized') as Block;

            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    value: '0x0',
                    data: actualCall
                },
                validBlockNumber.hash,
            ]
            const debugResult = await provider.send('debug_traceCall', callParams);
            expect(debugResult.failed).to.be.true;
            expect(debugResult.returnValue).to.be.a('string').with.length.gt(0);
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
            expect(debugResult).to.have.property('input').that.is.a('string');
            expect(debugResult).to.have.property('gasUsed');
            expect(parseInt(debugResult.gasUsed)).to.be.gt(0);
        });

        //@todo add earliest again
        const tags = ['finalized', 'safe'];
        for(const tag of tags) {
            it(`Can call debug_traceCall with block tag ${tag}`, async () => {
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
                        // gasPrice: ethers.toQuantity(100000),
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
                        // gasPrice: ethers.toQuantity(100000),
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
                        // gasPrice: ethers.toQuantity(100000),
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
                for (const [storage, value] of Object.entries(ercContractData)) {
                    const queriedStorage = await provider.getStorage(erc20.getAddress(), storage);
                    expect(queriedStorage).to.be.eq(value);
                }
            });

            it(`Can use call tracer with block tag ${tag} with onlyTopCall false returns subcalls`, async () => {
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
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
                expect(debugResult.calls).to.be.an('array').with.length.gt(0);
                expect(debugResult.calls[0].from.toLowerCase()).to.be.eq((await debugContract.getAddress()).toLowerCase());
                expect(debugResult.calls[0].to.toLowerCase()).to.be.eq(erc20.getAddress().toString().toLowerCase());
            });

            it(`Can use with only top call true with call tracer with tag ${tag}`, async () => {
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
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

        it('Debug trace call prestate tracer updates with data changes', async () =>{
            const tx = await erc20.mint(admin.evmAddress, ethers.parseEther('100').toString());
            await tx.wait();
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    // gasPrice: ethers.toQuantity(100000),
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
            for (const [storage, value] of Object.entries(ercContractData)) {
                const queriedStorage = await provider.getStorage(erc20.getAddress(), storage);
                expect(queriedStorage).to.be.eq(value);
            }

        });

        const tracerConfigs = ['prestateTracer', 'callTracer'];
        const topCallConfigs = [true, false];
        for(const tracer of tracerConfigs) {
            it(`Users can call ${tracer} to check state with debug call with blockhash with passing tx`, async () => {
                const validBlockNumber = await provider.getBlock('finalized') as Block;
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
                        // gasPrice: ethers.toQuantity(100000),
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

            it(`Users can call ${tracer} to check state with debug call block number`, async () => {
                const validBlockNumber = await provider.getBlock('finalized') as Block;
                const callParams = [
                    {
                        from: admin.evmAddress,
                        to: await debugContract.getAddress(),
                        // gasPrice: ethers.toQuantity(100000),
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
                it(`Users can call ${tracer} to check state with debug call with blockhash with passing tx with topCall ${topCallConfig}`, async () => {
                    const validBlockNumber = await provider.getBlock('finalized') as Block;
                    const callParams = [
                        {
                            from: admin.evmAddress,
                            to: await debugContract.getAddress(),
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
                        expect(debugResult['calls']).to.be.an('array').with.length.gt(0);
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                    }
                });

                it(`Users can call ${tracer} to check state with debug call block number with top call ${topCallConfig}`, async () => {
                    const validBlockNumber = await provider.getBlock('finalized') as Block;
                    const callParams = [
                        {
                            from: admin.evmAddress,
                            to: await debugContract.getAddress(),
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
                        expect(debugResult['calls']).to.be.an('array').with.length.gt(0);
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
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

        it('Can trace transaction with default parameters', async () => {
            const params = [
                txHash
            ]
            const debugResult = await provider.send('debug_traceTransaction', params);
            expect(debugResult.failed).to.be.false;
            expect(debugResult.gas).to.be.above(10000);
            expect(debugResult.structLogs).to.have.length.gt(10);
            expect(debugResult).to.have.property('returnValue');

            const firstLog = debugResult.structLogs[0];
            expect(firstLog).to.have.property('op').that.is.a('string');
            expect(firstLog).to.have.property('pc').that.is.a('number');
            expect(firstLog).to.have.property('gas').that.is.a('number');
            expect(firstLog).to.have.property('gasCost').that.is.a('number');
            expect(firstLog).to.have.property('depth').that.is.a('number');
        });

        it('Trace transaction with default parameters match with eth get block Receipt', async () =>{
            const rpcCall = await rpcClient.getTransactionReceipt(txHash);
            const params = [
                txHash
            ]
            const debugResult = await provider.send('debug_traceTransaction', params);
            expect(ethers.toNumber(rpcCall.gasUsed)).to.be.eq(debugResult.gas);
        });

        it('Trace transaction data is consistent with transaction receipt call with diff mode on', async () =>{
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

            expect(debugResult).to.have.property('pre');
            expect(debugResult).to.have.property('post');

            const adminAddrLower = admin.evmAddress.toLowerCase();
            expect(debugResult['pre']).to.have.property(adminAddrLower);
            expect(debugResult['post']).to.have.property(adminAddrLower);
            expect(debugResult['pre'][adminAddrLower]).to.have.property('balance');
            expect(debugResult['post'][adminAddrLower]).to.have.property('balance');

            const preBalanceFromTrace = BigInt(debugResult['pre'][adminAddrLower]['balance']);
            const postBalanceFromTrace = BigInt(debugResult['post'][adminAddrLower]['balance']);
            expect(preBalanceFromTrace > postBalanceFromTrace).to.be.true;

            const balanceDiff = preBalanceFromTrace - postBalanceFromTrace;
            const receipt = await rpcClient.getTransactionReceipt(txHash);
            const gasPaid = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);

            expect(balanceDiff === gasPaid).to.be.true;
        });

        it('Debug trace transaction returns valid info on valid txs with prestate tracer and diff mode false', async () =>{
            const adminAddrLower = admin.evmAddress.toLowerCase();
            const debugContractAddr = (await debugContract.getAddress()).toLowerCase();
            const erc20Addr = erc20.getAddress().toString().toLowerCase();

            const params = [
                txHash,
                {
                    tracer: 'prestateTracer',
                }
            ]
            const debugResult = await provider.send('debug_traceTransaction', params);

            expect(debugResult).to.have.property(adminAddrLower);
            expect(debugResult[adminAddrLower]).to.have.property('balance');
            expect(BigInt(debugResult[adminAddrLower]['balance']) > BigInt(0)).to.be.true;

            expect(debugResult).to.have.property(debugContractAddr);
            expect(debugResult[debugContractAddr]).to.have.property('code');
            expect(debugResult[debugContractAddr]['code']).to.be.eq(DebugContractAbi.deployedBytecode);

            expect(debugResult).to.have.property(erc20Addr);

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

            expect(debugResult2).to.have.property('pre');
            expect(debugResult2).to.have.property('post');
            expect(debugResult2['pre']).to.have.property(adminAddrLower);
            expect(debugResult2['post']).to.have.property(adminAddrLower);
            expect(BigInt(debugResult2['pre'][adminAddrLower]['balance'])
                > BigInt(debugResult2['post'][adminAddrLower]['balance'])).to.be.true;
        });

        it('Can get failing tx transactions', async () => {
            const callData = erc20.contract.interface.encodeFunctionData('transfer', [users[1].evmAddress, ethers.parseEther('1')]);
            try{
                const tx = await (await debugContract.lowLevelCall(erc20.getAddress(), callData, {gasLimit: 100000})).wait();
            } catch(e){
                failingTXHash = e.receipt?.hash;
            }
            expect(failingTXHash, 'failing-tx setup did not produce a tx hash; lowLevelCall may be swallowing the inner-call revert into a successful outer tx').to.be.a('string');
            const params = [
                failingTXHash
            ]
            const debugResult = await provider.send('debug_traceTransaction', params);
            expect(debugResult.failed).to.be.true;
            expect(debugResult.gas).to.be.above(10000);
            expect(debugResult.structLogs).to.have.length.gt(10);
            expect(debugResult).to.have.property('returnValue').that.is.a('string');
            expect(debugResult.returnValue.length).to.be.gt(0);
        });

        const requireFailingTxHash = function (this: Mocha.Context) {
            if (!failingTXHash) {
                this.skip();
            }
        };

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
                    expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                }
                if(tracerConfig === 'callTracer') {
                    expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                    expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult).to.have.property('input').that.is.a('string');
                    expect(debugResult).to.have.property('gasUsed');
                    expect(parseInt(debugResult.gasUsed)).to.be.gt(0);
                    expect(parseInt(debugResult.gasUsed)).to.be.lte(parseInt(debugResult.gas));
                    expect(debugResult['calls']).to.be.an('array').with.length.gt(0);
                    expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                    expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                    expect(debugResult['calls'][0].value).to.be.eq('0x0');
                    expect(debugResult['calls'][0]).to.have.property('input');
                    expect(debugResult['calls'][0]).to.have.property('gasUsed');
                }
            });

            it(`Can see debug trace transaction with ${tracerConfig} for failing tx`, async function() {
                requireFailingTxHash.call(this);
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
                        expect(debugResult[(await debugContract.getAddress()).toLowerCase()]['code']).to.be.eq(DebugContractAbi.deployedBytecode)
                    }
                    if(tracerConfig === 'callTracer') {
                        expect(debugResult['from']).to.be.eq(admin.evmAddress.toLowerCase());
                        expect(debugResult['to']).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls']).to.be.an('array').with.length.gt(0);
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                    }
                });

                it(`Can see debug trace transaction with ${tracerConfig} for failing tx with top call ${topCallConfig}`, async function() {
                    requireFailingTxHash.call(this);
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
                        expect(debugResult['error']).to.be.eq('execution reverted');
                        expect(debugResult['revertReason']).to.be.eq('Call failed');
                        expect(debugResult['calls']).to.be.an('array').with.length.gt(0);
                        expect(debugResult['calls'][0].from).to.be.eq((await debugContract.getAddress()).toLowerCase());
                        expect(debugResult['calls'][0].to).to.be.eq(erc20.getAddress().toLowerCase());
                    }
                })
            }
        }
    });

    describe('Tests debug_traceBlockByNumber and blockByHash', function(){
        let blockNumber: Uint8Array | ethers.BlockTag;
        let blockHash: string;

        let numberDebugResult: [];
        it('Debugs block with 40 txs in it - block number', async () => {
            const txs = [];
            for (let i = 0; i<users.length; i++) {
                txs.push(erc20.contract.connect(users[i].evmWallet.wallet).transfer(admin.evmAddress, ethers.parseEther('0.1'), {gasLimit: 500000}));
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
            //find max of block number
            let bestKey: any;
            let bestVal = -Infinity;

            for (const [k, v] of blockNumbers) {
                if (v > bestVal) {
                    bestVal = v;
                    bestKey = k;
                }
            }
            // blockNumber = receipts[0]!.blockNumber;
            blockNumber = bestKey;
            for (let attempt = 0; attempt < 30; attempt++) {
                const block = await provider.getBlock(blockNumber);
                if (block?.hash) {
                    blockHash = block.hash;
                    break;
                }
                await waitFor(1);
            }
            expect(blockHash, 'block hash never populated for confirmed block').to.be.a('string').that.matches(/^0x[0-9a-fA-F]{64}$/);
            const params = [
                ethers.toQuantity(blockNumber),
            ];
            numberDebugResult = await provider.send('debug_traceBlockByNumber', params);
            expect(numberDebugResult.length).to.be.gte(blockNumbers.get(blockNumber));
        });

        let hashDebugResult: [];
        it('Debugs block with 40 txs in it -  block hash', async () =>{
            const params = [
                blockHash,
            ];
            hashDebugResult = await provider.send('debug_traceBlockByHash', params);
            expect(hashDebugResult.length).to.be.gte(2);

            const entry = hashDebugResult[0] as any;
            expect(entry).to.have.property('txHash').that.is.a('string');
            expect(entry.txHash).to.match(/^0x[0-9a-fA-F]{64}$/);
            expect(entry).to.have.property('result');
            expect(entry.result).to.have.property('gas').that.is.a('number');
            expect(entry.result).to.have.property('failed');
            expect(entry.result).to.have.property('structLogs').that.is.an('array');
            expect(entry.result).to.have.property('returnValue');
        });

        it('Debug trace block by number and debug trace by block hash returns same information', async () =>{
            expect(_.isEqual(numberDebugResult, hashDebugResult)).to.be.true;
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
                expect(debugResult.length).to.be.gte(2);
            });

            it(`Queries block with number ${tracerConfig}`, async () =>{
                const params = [
                    ethers.toQuantity(blockNumber),
                    {
                        tracer: tracerConfig,
                    }
                ];
                const debugResult = await provider.send('debug_traceBlockByNumber', params);
                expect(debugResult.length).to.be.gte(2);
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

        it('debug_traceBlockByNumber fails with non-existent block number', async () => {
            const currentBlock = await provider.getBlockNumber();
            const params = [ethers.toQuantity(currentBlock + 10000)];
            try {
                await provider.send('debug_traceBlockByNumber', params);
                throw new Error('Should have failed');
            } catch (e: any) {
                expect(e.message).to.not.eq('Should have failed');
            }
        });

        it('debug_traceBlockByHash fails with non-existent block hash', async () => {
            const params = ['0x0000000000000000000000000000000000000000000000000000000000000000'];
            try {
                await provider.send('debug_traceBlockByHash', params);
                throw new Error('Should have failed');
            } catch (e: any) {
                expect(e.message).to.not.eq('Should have failed');
            }
        });
    });

    describe('Missing edge cases', function () {
        it('debug_traceTransaction fails with non-existent tx hash', async () => {
            const fakeTxHash = '0x0000000000000000000000000000000000000000000000000000000000000000';
            try {
                await provider.send('debug_traceTransaction', [fakeTxHash]);
                throw new Error('Should have failed');
            } catch (e: any) {
                expect(e.message).to.not.eq('Should have failed');
            }
        });

        it('debug_traceCall works with latest block tag', async () => {
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    value: '0x0',
                    data: actualCall
                },
                'latest',
            ];
            const debugResult = await provider.send('debug_traceCall', callParams);
            expect(debugResult.failed).to.be.false;
            expect(debugResult.gas).to.be.gt(25000);
            expect(debugResult.structLogs).to.have.length.gt(2);
        });

        it('debug_traceCall with callTracer on latest block tag', async () => {
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: await debugContract.getAddress(),
                    value: '0x0',
                    data: actualCall
                },
                'latest',
                {tracer: 'callTracer'}
            ];
            const debugResult = await provider.send('debug_traceCall', callParams);
            expect(debugResult.from.toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
            expect(debugResult.to.toLowerCase()).to.be.eq((await debugContract.getAddress()).toLowerCase());
            expect(debugResult.type).to.be.eq('CALL');
            expect(parseInt(debugResult.gas)).to.be.gt(0);
        });

        it('debug_traceCall with a simple value transfer (no contract call)', async () => {
            const validBlockNumber = await provider.getBlock('finalized') as Block;
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: users[0].evmAddress,
                    value: ethers.toQuantity(ethers.parseEther('0.01')),
                },
                ethers.toQuantity(validBlockNumber.number),
            ];
            const debugResult = await provider.send('debug_traceCall', callParams);
            expect(debugResult.failed).to.be.false;
            expect(debugResult.gas).to.be.gte(21000);
            expect(debugResult.structLogs).to.be.an('array');
        });

        it('debug_traceCall with callTracer for a simple value transfer', async () => {
            const validBlockNumber = await provider.getBlock('finalized') as Block;
            const callParams = [
                {
                    from: admin.evmAddress,
                    to: users[0].evmAddress,
                    value: ethers.toQuantity(ethers.parseEther('0.01')),
                },
                ethers.toQuantity(validBlockNumber.number),
                {tracer: 'callTracer'}
            ];
            const debugResult = await provider.send('debug_traceCall', callParams);
            expect(debugResult.from.toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
            expect(debugResult.to.toLowerCase()).to.be.eq(users[0].evmAddress.toLowerCase());
            expect(debugResult.type).to.be.eq('CALL');
            expect(debugResult.value).to.be.eq(ethers.toQuantity(ethers.parseEther('0.01')));
            expect(debugResult.calls === undefined || debugResult.calls === null || debugResult.calls.length === 0).to.be.true;
        });
    });
})

import {SeiUser} from "../../modules/utils/User";
import {ERC20Token} from "../shared/Token";
import RPCClient from "../../tokens/utils/RPCClient";
import {CW20Token} from "../../tokens/utils/Token20";
import {Funder} from "../../modules/utils/Funder";
import testConfig from "../testConfig.json";
import {returnExpect} from "../../modules/bank/utils";
import {Block, ContractTransactionReceipt, ethers, LogDescription} from "ethers";
import {ExecuteResult} from "@cosmjs/cosmwasm-stargate";
import {TestNFT__factory} from "../../tokens/typechain-types";
import ContractArtifacts from '../artifacts/contracts/TestNFT.sol/TestNFT.json';
import {waitFor} from "../../modules/tokenfactory/helpers";
import {createUsersFromMnemonic} from "../shared/EvmUtils";
import ContractAddresses from "../contractAddresses.json";

describe('Evm Rpc Tests', function () {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let expect: Chai.ExpectStatic;
    let erc20: ERC20Token;
    let rpcClient: RPCClient;
    let cwPointerAddress: string;
    let cwContractAddress: string;
    let ercPointerAddress: string;
    let pointerCw20: CW20Token;
    let baseCw20: CW20Token;
    let funder: Funder;

    before('Initializes', async () => {
        admin = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
        await admin.initialize(testConfig.mnemonic, 'admin', false);
        funder = new Funder(admin.seiAddress);
        users = await createUsersFromMnemonic();
        expect = await returnExpect();
        erc20 = new ERC20Token(admin, users, ContractAddresses.erc20);
        await erc20.initialize();
        rpcClient = new RPCClient(admin.evmWallet.signingClient);
        pointerCw20 = new CW20Token(ContractAddresses.ercPointerOnCosmos);
        baseCw20 = new CW20Token(ContractAddresses.cw20)
    })

    let multipleTxReceipt: ContractTransactionReceipt;
    let txBlocks: Map<string, number> = new Map<string, number>();
    it('Sends multiple evm txs', async () => {
        const responses = await erc20.sendMultipleTxFromUsers();
        multipleTxReceipt = responses[0];
        for (const response of responses) {
            expect(response.status).to.be.eq(1);
            if (txBlocks.has(response.blockNumber.toString())) {
                txBlocks.set(response.blockNumber.toString(), txBlocks.get(response.blockNumber.toString())! + 1);
            } else {
                txBlocks.set(response.blockNumber.toString(), 1);
            }
        }
        console.log('Sent tx number is ', responses.length);
    });

    let oneSyntheticOneEvmTx: ContractTransactionReceipt;
    it('Send a synthetic and evm tx', async () => {
        const results = await erc20.sendOneSyntheticOneEvmTx(baseCw20);
        oneSyntheticOneEvmTx = results[0];
    });

    let multipleSyntheticAndOneFailingEvmTx: ExecuteResult;
    it('Sends multiple failing txs', async () => {
        const results = await erc20.sendMultipleFailingTxs(ContractAddresses.ercPointerOnCosmos);
        multipleSyntheticAndOneFailingEvmTx = results[1];
    });

    let multipleSyntheticAndEvmTx: ContractTransactionReceipt;
    it('Sends multiple synthetic and multiple evm txs', async () => {
        const results = await Promise.all([
            baseCw20.transfer(users[0], users[1], '100000000'),
            baseCw20.transfer(users[2], users[3], '100000000'),
            baseCw20.transfer(users[4], users[5], '100000000'),
            erc20.sendOneTx(users[6]),
            erc20.sendOneTx(users[7]),
            erc20.sendOneTx(users[8])
        ])
        multipleSyntheticAndEvmTx = results[3];
    });

    it('Can read topics with more than 100 logs', async () => {
        const provider = admin.evmWallet.signingClient;
        for (const blockNumber of txBlocks.keys()) {
            const blockHash = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])).hash;
            let blockRpc;
            let txIndexes = new Set();
            let logIndexes = new Set();
            const expectedLogIndexes = new Array(txBlocks.get(blockNumber)).fill(0)
                .map((_, index) => ethers.toQuantity(index));
            const logParams = {
                fromBlock: ethers.toQuantity(blockNumber),
                toBlock: ethers.toQuantity(blockNumber),
                topics: [ethers.id('Transfer(address,address,uint256)')],
                address: erc20.contractAddress
            }
            blockRpc = await provider.send('eth_getLogs', [logParams]);
            expect(blockRpc.length).to.be.eq(txBlocks.get(blockNumber));

            for(const topic of blockRpc) {
                expect(topic.address.toLowerCase()).to.be.eq(erc20.contractAddress.toLowerCase());
                const parsed = erc20.contract.interface.parseLog(topic) as LogDescription;
                expect(parsed.name).to.be.eq('Transfer');
                expect(parsed.args[1]).to.equal(admin.evmAddress);
                expect(ethers.formatEther(parsed.args[2].toString())).to.equal('0.1')
                expect(ethers.toNumber(topic.blockNumber)).to.be.eq(Number(blockNumber));
                expect(topic.blockHash).to.be.eq(blockHash);
                txIndexes.add(topic.transactionIndex);
                logIndexes.add(topic.logIndex);
                // Verify that log indexes start from 0
                expect(topic.logIndex).to.be.oneOf(expectedLogIndexes);
            }
            expect(txIndexes.size).to.be.eq(txBlocks.get(blockNumber));
            expect(logIndexes.size).to.be.eq(txBlocks.get(blockNumber));
        }
    });

    it('Cant read topics given that there are failing txs and multiple cosmos txs from pointer on cosmos', async () => {
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx.height) -1),
            toBlock: ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx.height) + 1),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.contractAddress
        }
        const logResponses = await rpcClient.sei_getLogs(logsParams);
        let txIndexes = new Set();
        let logIndexes = new Set();
        const expectedLogIndexes = new Array(users.length).fill(0)
            .map((_, index) => ethers.toQuantity(index));
        for(const topic of logResponses) {
            expect(topic.address.toLowerCase()).to.be.eq(erc20.contractAddress.toLowerCase());
            const parsed = erc20.contract.interface.parseLog(topic) as LogDescription;
            expect(parsed.name).to.be.eq('Transfer');
            expect(parsed.args[0]).to.equal(admin.evmAddress);
            expect(ethers.formatEther(parsed.args[2].toString())).to.equal('0.0000000000001')
            txIndexes.add(topic.transactionIndex);
            logIndexes.add(topic.logIndex);
            // Verify that log indexes start from 0
            expect(topic.logIndex).to.be.oneOf(expectedLogIndexes);
        }
        expect(txIndexes.size).to.be.eq(1);
        expect(logIndexes.size).to.be.eq(users.length);
    });

    it('Can read topics with both synthetic and evm txs', async () => {
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(oneSyntheticOneEvmTx.blockNumber) -1),
            toBlock: ethers.toQuantity(Number(oneSyntheticOneEvmTx.blockNumber) + 1),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        }
        const logResponses = await rpcClient.sei_getLogs(logsParams);
        expect(logResponses.length).to.be.eq(2);
    });

    it('Can read topics with both erc20 and erc721 events', async () => {
        const erc721ContractFactory = new ethers.ContractFactory(ContractArtifacts.abi, ContractArtifacts.bytecode, admin.evmWallet.wallet) as unknown as TestNFT__factory;
        const erc721Contract = await erc721ContractFactory.deploy(admin.evmAddress);
        await erc721Contract.waitForDeployment();
        await (await erc721Contract.safeMint(admin.evmAddress, '1')).wait()
        const results= await Promise.all([
            (await erc721Contract.approve(users[1].evmAddress, '1')).wait(),
            erc20.sendOneTx(users[0])
        ])
        await waitFor(1);
        const logParams1 = {
            fromBlock: ethers.toQuantity(Number(results[0]!.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(results[0]!.blockNumber) + 2),
            topics: [ethers.id('Approval(address,address,uint256)')],
        }
        const logs = await rpcClient.eth_getLogs(logParams1);
        const logParams2 = {
            fromBlock: ethers.toQuantity(Number(results[0]!.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(results[0]!.blockNumber) + 2),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        }
        const logs2 = await rpcClient.eth_getLogs(logParams2);

        const combinedLogs = {
            fromBlock: ethers.toQuantity(Number(results[0]!.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(results[0]!.blockNumber) + 2),
            // topics: [ethers.id('Transfer(address,address,uint256)'), ethers.id('Approval(address, address,uint256)')],
            topics: [[
                ethers.id('Transfer(address,address,uint256)'),
                ethers.id('Approval(address,address,uint256)')
            ]],
        }
        const logsCombined = await rpcClient.eth_getLogs(combinedLogs);
        expect(logsCombined.length).to.be.eq(logs.length + logs2.length);

    });

    it('Synthetic events wont show up on the eth call', async () => {
        return true;
    });

    it('Can read events from multiple contracts', async () => {
        return true;
    });

    it('Can return txs successfully for a span of 100 blocks', async () => {
        const results = await Promise.all([
            baseCw20.transfer(users[0], users[1], '100000000'),
            baseCw20.transfer(users[2], users[3], '100000000'),
            baseCw20.transfer(users[4], users[5], '100000000'),
            erc20.sendOneTx(users[6]),
            erc20.sendOneTx(users[7]),
            erc20.sendOneTx(users[8])
        ])
        await waitFor(60);
        const logParams = {
            fromBlock: ethers.toQuantity(results[3].blockNumber - 5),
            toBlock: 'latest',
            topics: [ethers.id('Transfer(address,address,uint256)')],
            contractAddress: erc20.contractAddress,
        }
        const rpcCall = await rpcClient.eth_getLogs(logParams);
        expect(rpcCall.length).to.be.eq(3);
    });

    let i = 0;
    const tags = ['finalized', 'safe', 'latest', 'pending'];
    for(const tag of tags) {
        it(`From block ${tag} return info as expected`, async () => {
            await waitFor(2);
            const tx = erc20.sendOneSyntheticOneEvmTx(baseCw20, i);
            let index = 0;
            while(index < 200){
                const logParams = {
                    fromBlock: tag,
                    topics: [ethers.id('Transfer(address,address,uint256)')],
                    address: erc20.contractAddress
                }
                const rpc = await rpcClient.eth_getLogs(logParams);
                if(rpc.length > 0){
                    i++;
                    return true;
                } else {
                    await waitFor(0.02);
                    index++;
                }
            }
            throw new Error('I threw this error occurred.');
        });

        it(`To block ${tag} return info as expected`, async () => {
            await waitFor(2);
            const blockNum = await admin.evmWallet.signingClient.getBlock('latest') as unknown as Block;

            const tx = erc20.sendOneSyntheticOneEvmTx(baseCw20);
            let index = 0;
            while(index < 200){
                const logParams = {
                    fromBlock: ethers.toQuantity(blockNum.number - 2),
                    toBlock: tag,
                    topics: [ethers.id('Transfer(address,address,uint256)')],
                    address: erc20.contractAddress
                }
                const rpc = await rpcClient.eth_getLogs(logParams);
                if(rpc.length > 0){
                    return true;
                } else {
                    await waitFor(0.02);
                    index++;
                }
            }
            throw new Error('I threw this error occurred.');
        });
    }
})
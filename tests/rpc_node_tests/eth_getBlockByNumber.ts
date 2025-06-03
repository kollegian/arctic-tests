import {SeiUser} from "../../modules/utils/User";
import testConfig from "../testConfig.json";
import {Funder} from "../../modules/utils/Funder";
import {returnExpect} from "../../modules/bank/utils";
import {ERC20Token} from "../shared/Token";
import RPCClient from "../../tokens/utils/RPCClient";
import {Block, ContractTransactionReceipt, ethers} from "ethers";
import {waitFor} from "../../modules/tokenfactory/helpers";
import {CW20Token} from "../../tokens/utils/Token20";
import {createUsersFromMnemonic} from "../shared/EvmUtils";
import ContractAddresses from '../contractAddresses.json';
import {ExecuteResult} from "@cosmjs/cosmwasm-stargate";

describe('Evm Rpc Tests', function () {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let expect: Chai.ExpectStatic;
    let erc20: ERC20Token;
    let rpcClient: RPCClient;
    let baseCw20: CW20Token;

    before('Initializes', async () => {
        admin = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
        await admin.initialize(testConfig.mnemonic, 'admin', false);
        users = await createUsersFromMnemonic();
        expect = await returnExpect();
        erc20 = new ERC20Token(admin, users, ContractAddresses.erc20);
        await erc20.initialize();
        rpcClient = new RPCClient(admin.evmWallet.signingClient);
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
        console.log(txBlocks);
    });

    let oneSyntheticOneEvmTx: ContractTransactionReceipt;
    it('Send a synthetic and evm tx', async () => {
        const results = await erc20.sendOneSyntheticOneEvmTx(baseCw20);
        oneSyntheticOneEvmTx = results[0];
    });

    let multipleSyntheticAndOneFailingEvmTx: ExecuteResult;
    let failingTxHash: string;
    it('Sends multiple failing txs', async () => {
        const results = await erc20.sendMultipleFailingTxs(ContractAddresses.cw20);
        failingTxHash = results[0].receipt.hash;
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
    })

    it('Given there are multiple txs on a block, eth_getBlockByNumber returns gas as expected', async () => {
        const provider = admin.evmWallet.signingClient;
        for (const blockNumber of txBlocks.keys()) {
            let totalGas = 0;
            let blockRpc;
            let txIndexes = new Set();
            blockRpc = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), true]);
            for (const tx of blockRpc.transactions) {
                const txReceipt = await provider.send('eth_getTransactionReceipt', [tx.hash]);
                totalGas += ethers.toNumber(txReceipt.gasUsed);
                txIndexes.add(tx.transactionIndex);
            }
            expect(totalGas).to.equal(ethers.toNumber(blockRpc.gasUsed));
            expect(txIndexes.size).to.equal(blockRpc.transactions.length);
        }
    });

    it('Given that there are synthetic and evm events on a block, eth_getBlockByNumber returns gas as expected', async () => {
        const provider = admin.evmWallet.signingClient;
        const blockInfo = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(multipleSyntheticAndEvmTx.blockNumber), true]);
        expect(blockInfo.transactions.length).to.be.greaterThan(0);
        expect(ethers.toNumber(blockInfo.gasLimit)).to.be.gt(100000);
    });

    it('Given that there are synthetic and failing txs on a block, eth_getBlockByNumber returns gas as expected', async () => {
        const provider = admin.evmWallet.signingClient;
        const logs = {
            fromBlock: ethers.toQuantity(multipleSyntheticAndOneFailingEvmTx.height -1),
            toBlock: ethers.toQuantity(multipleSyntheticAndOneFailingEvmTx.height + 1),
            topic: ethers.id('Transfer(address,address,uint256)'),
        }
        const blockInfo = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(multipleSyntheticAndOneFailingEvmTx.height), true]);
        expect(blockInfo.transactions.length).to.be.greaterThan(0);
        expect(ethers.toNumber(blockInfo.gasLimit)).to.be.gt(10000000);
        expect(blockInfo.transactions[0].hash).to.be.eq(failingTxHash);
    })

    it('Given that heavy txs base gas fee increases on block call', async () =>{
        const resp = await erc20.sendMultipleTxFromUsers();
        const baseFeePerGases = [];
        for(let blockNum = Number(resp[0].blockNumber) -1; blockNum <= Number(resp[0].blockNumber) + 4; blockNum ++){
            const blockInfo = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(blockNum), true) as Block;
            baseFeePerGases.push(ethers.toNumber(blockInfo.baseFeePerGas));
        }
        expect(baseFeePerGases.filter(baseFee => baseFee > 100000000).length).to.be.greaterThan(0);
    });

    const tags = ['latest', 'finalized', 'safe', 'pending'];
    for(const tag of tags){
        it(`Eth get block by number returns info with ${tag} for multiple txs`, async () => {
            await waitFor(2);
            const provider = admin.evmWallet.signingClient;
            let tries = 0;
            erc20.sendMultipleTxFromUsers();
            while(tries < 400){
                const results = await provider.send('eth_getBlockByNumber', [tag, true]);
                if(results.transactions.length > 25){
                    const indexes = new Set();
                    for(const tx of results.transactions){
                        indexes.add(tx.transactionIndex);
                    }
                    return expect(indexes.size).to.equal(results.transactions.length);
                } else {
                    await waitFor(0.04);
                    tries++;
                }
            }
            if(tries === 200){
                console.log('I couldnt find it');
            }
            await waitFor(3);
        })
    }
})
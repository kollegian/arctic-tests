import {SeiUser} from "../../modules/utils/User";
import {ERC20Token} from "../shared/Token";
import RPCClient from "../../tokens/utils/RPCClient";
import {CW20Token} from "../../tokens/utils/Token20";
import testConfig from "../testConfig.json";
import {returnExpect} from "../../modules/bank/utils";
import {Block, ethers, LogDescription} from "ethers";
import pointerArtifacts from "../CW20ERC20Pointer.json";
import {waitFor} from "../../modules/tokenfactory/helpers";
import {createUsersFromMnemonic} from "../shared/EvmUtils";
import ContractAddresses from "../contractAddresses.json";

describe('Sei get logs tests', function() {
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
        expect = await returnExpect();
        users = await createUsersFromMnemonic();
        expect = await returnExpect();
        erc20 = new ERC20Token(admin, users, ContractAddresses.erc20);
        await erc20.initialize();
        rpcClient = new RPCClient(admin.evmWallet.signingClient);
        baseCw20 = new CW20Token(ContractAddresses.cw20)
    })

    it('Given that there are synthetic and evm txs, sei get logs return info for all', async function() {
        const tx = await erc20.sendMultipleSyntheticOneEvmTx(ContractAddresses.cw20);
        const logsParams = {
            fromBlock: ethers.toQuantity(tx[0].blockNumber - 1),
            toBlock: ethers.toQuantity(tx[0].blockNumber + 6),
            address: ContractAddresses.cwPointerOnEvm
        }
        const logs = await rpcClient.sei_getLogs(logsParams);
        expect(logs.length).to.be.eq(users.length);
        let logIndexes = new Set();
        for(const log of logs){
            logIndexes.add(log.logIndex);
            expect(log.address.toLowerCase()).to.be.eq(ContractAddresses.cwPointerOnEvm.toLowerCase());
            expect(ethers.toNumber(log.blockNumber)).to.be.eq(tx[1].height);
            const pointerContract = new ethers.Contract(ContractAddresses.cwPointerOnEvm, pointerArtifacts.abi, admin.evmWallet.wallet);
            const decodedData = pointerContract.interface.parseLog(log) as LogDescription;
            expect(decodedData.name).to.be.eq('Transfer');
            expect(decodedData.args[0].toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
            expect(decodedData.args[2].toString()).to.be.eq('100000');
        }
        expect(logIndexes.size).to.be.eq(logs.length);

        const allEventLogs = {
            fromBlock: ethers.toQuantity(tx[0].blockNumber - 1),
            toBlock: ethers.toQuantity(tx[0].blockNumber + 3),
        }
        const allLogs = await rpcClient.sei_getLogs(allEventLogs);
        expect(allLogs.length).to.be.eq(users.length + 1);
    });

    it('Given that synthetic events thrown from pointer on cosmos, sei get logs return info for all', async function() {
        const tx = await erc20.sendMultipleSyntheticOneEvmTx(ContractAddresses.cw20);
        const logParams = {
            fromBlock: ethers.toQuantity(tx[0].blockNumber - 1),
            toBlock: ethers.toQuantity(tx[0].blockNumber + 3),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        }
        const rpc = await rpcClient.sei_getLogs(logParams);
        expect(rpc.length).to.be.eq(users.length + 1);
    });

    it('Given that there are multiple txs thrown synthetically, sei get logs return all of them', async function() {
        const txs = users.map(user => {
            return baseCw20.transfer(user, admin, '100000');
        });
        const results = await Promise.all(txs);
        await waitFor(3);
        const blockHeights = results.reduce((prev, current) => {
            if (prev.has(current.height.toString())){
                const prevIndex = prev.get(current.height.toString())!;
                prev.set(current.height.toString(), prevIndex + 1);
            } else {
                prev.set(current.height.toString(), 1);
            }
            return prev;
        }, new Map<string, number>());
        console.log('Block heights are ', blockHeights);
        console.log('Logs from block is ', results[0].height - 2);
        console.log('Logs to block is ', results[0].height + 3);
        const logParams = {
            fromBlock: ethers.toQuantity(results[0].height - 2),
            toBlock: ethers.toQuantity(results[0].height + 3),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: ContractAddresses.cwPointerOnEvm,
        }
        const logs = await rpcClient.sei_getLogs(logParams);
        expect(logs.length).to.be.eq(users.length);
        const logIndexes = new Set();
        for(const log of logs){
            logIndexes.add(log.logIndex);
            expect(log.address.toLowerCase()).to.be.eq(ContractAddresses.cwPointerOnEvm.toLowerCase());
            expect(ethers.toNumber(log.blockNumber)).to.be.oneOf(Array.from(blockHeights.keys()).map(key => parseInt(key)));
            const pointerContract = new ethers.Contract(ContractAddresses.cwPointerOnEvm, pointerArtifacts.abi, admin.evmWallet.wallet);
            const decodedData = pointerContract.interface.parseLog(log) as LogDescription;
            expect(decodedData.name).to.be.eq('Transfer');
            expect(decodedData.args[1].toLowerCase()).to.be.eq(admin.evmAddress.toLowerCase());
            expect(decodedData.args[2].toString()).to.be.eq('100000');
        }
        expect(logIndexes.size).to.be.gt(5);
    });

    it('Sei get logs can return multiple topics with OR', async function() {
        const txs = await Promise.all( [
            baseCw20.increaseAllowance(admin, users[0].seiAddress, '10000'),
            baseCw20.increaseAllowance(users[1], users[2].seiAddress, '10000'),
            erc20.sendOneTx(admin)
        ]);
        const logParams = {
            fromBlock: ethers.toQuantity(txs[0].height - 3),
            toBlock: ethers.toQuantity(txs[0].height + 3),
            topics: [
                [ethers.id('Transfer(address,address,uint256)'), ethers.id('Approval(address,address,uint256)')],
            ]
        }
        const rpc = await rpcClient.sei_getLogs(logParams);
        expect(rpc.length).to.be.eq(3);
    });

    it('Sei get logs return txs from multiple blocks', async function() {
       await waitFor(3);
       const startBlock = await admin.evmWallet.signingClient.getBlock('latest') as unknown as Block;
       for (let i = 0; i < 10; i++) {
           await baseCw20.transfer(users[i], admin, '10000');
           await waitFor(0.2);
       }
       await waitFor(0.5);
       const endBlock = await admin.evmWallet.signingClient.getBlock('latest') as unknown as Block;
       const logParams = {
           fromBlock: ethers.toQuantity(startBlock.number),
           toBlock: ethers.toQuantity(endBlock.number),
       }
       const rpc = await rpcClient.sei_getLogs(logParams);
       expect(rpc.length).to.be.eq(10);
    });

    it('Given that there is a failing tx on evm side, sei logs return successfully', async function() {
        const txs = await Promise.all( [
            baseCw20.increaseAllowance(admin, users[0].seiAddress, '10000'),
            erc20.contract.transfer(users[0].evmAddress, ethers.parseEther('1000000'), {gasLimit: 1000000}).catch(err => err),
            baseCw20.transfer(users[2], admin, '10000000'),
            erc20.sendOneTx(users[5]),
        ])
        const logParams = {
            fromBlock: ethers.toQuantity(txs[0].height - 3),
            toBlock: ethers.toQuantity(txs[0].height + 3),
            topics: [
                [ethers.id('Transfer(address,address,uint256)'), ethers.id('Approval(address,address,uint256)')],
            ]
        }
        const logs = await rpcClient.sei_getLogs(logParams);
        expect(logs.length).to.be.eq(3);
    });

    it('Given that there is a failing synthetic tx, sei logs return successfully', async function() {
        const txs = await Promise.all( [
            baseCw20.increaseAllowance(admin, users[0].seiAddress, '10000'),
            baseCw20.transfer(users[2], admin, '1000000000000000').catch(err => err),
            erc20.sendOneTx(users[5]),
            baseCw20.transfer(users[1], users[2], '1000'),
        ])

        const logParams = {
            fromBlock: ethers.toQuantity(txs[0].height - 3),
            toBlock: ethers.toQuantity(txs[0].height + 3),
            topics: [
                [ethers.id('Transfer(address,address,uint256)'), ethers.id('Approval(address,address,uint256)')],
            ]
        }
        const logs = await rpcClient.sei_getLogs(logParams);
        expect(logs.length).to.be.eq(3);
    });

    let i = 0;
    const tags = ['latest', 'finalized', 'safe', 'pending'];
    for(let tag of tags) {
        it(`Sei get logs support ${tag} on to block field`, async function() {
            await waitFor(2);
            baseCw20.transfer(admin, users[i], '1000')
            let index = 0;
            while(index < 200){
                const logParams = {
                    fromBlock: tag,
                    topics: [ethers.id('Transfer(address,address,uint256)')],
                }
                const rpc = await rpcClient.sei_getLogs(logParams);
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

        it(`Sei get logs support ${tag} on from block field`, async function() {
            await waitFor(2);
            const blockNum = await admin.evmWallet.signingClient.getBlock('latest') as unknown as Block;
            baseCw20.transfer(admin, users[0], '1000')
            let index = 0;
            while(index < 200){
                const logParams = {
                    fromBlock: ethers.toQuantity(blockNum.number - 2),
                    toBlock: tag,
                    topics: [ethers.id('Transfer(address,address,uint256)')],
                }
                const rpc = await rpcClient.sei_getLogs(logParams);
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
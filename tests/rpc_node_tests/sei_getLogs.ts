import { SeiUser, UserFactory } from "../../shared/User";
import { Cw20Token, Erc20Token } from "../../shared/Token";
import contractAddresses from './contractAddresses.json';
import { EvmRpcClient } from "../../shared/RpcClient";
import { Block, ethers, LogDescription } from "ethers";
import { expect } from "chai";
import { waitFor } from "../../shared/utils/helpers";
import { AtomicTxSender } from "../../shared/TxBuilder";
import { TokenDeployer } from "../../shared/Deployer";


describe('Sei get logs tests', function() {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let erc20: Erc20Token;
    let rpcClient: EvmRpcClient;
    let baseCw20: Cw20Token;
    let txBlocks: Map<string, number> = new Map<string, number>();
    let multipleTxReceipt: any;
    let oneSyntheticOneEvmTx: any;
    let multipleSyntheticAndOneFailingEvmTx: any;
    let multipleSyntheticAndEvmTx: any;
    let multipleTxBlock: any;

    before('Initializes', async () => {
        admin = await UserFactory.createAdminUser();
        users = await UserFactory.createSeiUsers(admin, 5, true);
        erc20 = new Erc20Token(admin, contractAddresses.erc20);
        baseCw20 = new Cw20Token(admin, contractAddresses.cw20);
        rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
    });

    it('Sends multiple synthetic txs and validates logs', async () => {
        const responses = await erc20.sendMultipleTxs(users);
        multipleTxReceipt = responses[0];
        for (const response of responses) {
            expect(response.status).to.be.eq(1);
            if (txBlocks.has(response.blockNumber.toString())) {
                txBlocks.set(response.blockNumber.toString(), txBlocks.get(response.blockNumber.toString())! + 1);
            } else {
                txBlocks.set(response.blockNumber.toString(), 1);
            }
        }
        const blockNumber = responses[0].blockNumber;
        console.log(blockNumber);
        await waitFor(1);
        const logsParams = {
            fromBlock: ethers.toQuantity(blockNumber),
            toBlock: ethers.toQuantity(blockNumber),
            address: erc20.getAddress().toString(),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        };
        const logs = await rpcClient.sei_getLogs(logsParams);
        expect(logs.length).to.be.eq(users.length);
        for (const log of logs) {
            expect(log.address.toString().toLowerCase()).to.be.eq(erc20.getAddress().toString().toLowerCase());
            const parsed = erc20.contract.interface.parseLog(log) as LogDescription;
            expect(parsed.name).to.be.eq('Transfer');
            expect(parsed.args[1]).to.equal(admin.evmAddress);
            expect(ethers.formatEther(parsed.args[2].toString())).to.equal('0.01');
            expect(ethers.toNumber(log.blockNumber)).to.be.eq(Number(blockNumber));
        }
    });

    it('Send a synthetic and evm tx and validate logs', async () => {
        const encodedData = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('1')]);
        const signedTx = await AtomicTxSender.signEvmTransaction(users[0], erc20.getAddress(), encodedData);
        baseCw20.setSigner(users[1]);
        const delayed = async () =>{
            await waitFor(0.49);
            // The method expects 3 arguments: (rpcUrl, signedTx, sender) as per shared/TxBuilder.ts
            const txHash: string = await AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, users[0]);
            return txHash;
        }
        const results = await Promise.all([
            delayed(),
            baseCw20.transfer(admin.seiAddress, '100000'),
        ]);
        oneSyntheticOneEvmTx = await rpcClient.getTransactionReceipt(results[0]);
        expect(Number(oneSyntheticOneEvmTx.blockNumber)).to.be.eq(results[1].height);
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(oneSyntheticOneEvmTx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(oneSyntheticOneEvmTx.blockNumber) + 1),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        };
        const logResponses = await rpcClient.sei_getLogs(logsParams);
        expect(logResponses.length).to.be.eq(2);
    });

    it('Sends multiple failing txs and validates logs are empty', async () => {
        const encoded1 = erc20.contract.interface.encodeFunctionData('transfer', [users[0].evmAddress, ethers.parseEther('10000000000')]);
        const signed = await AtomicTxSender.signEvmTransaction(users[1], erc20.getAddress(), encoded1);
        const encoded2 = erc20.contract.interface.encodeFunctionData('transfer', [users[2].evmAddress, ethers.parseEther('10000000000')]);
        const signed2 = await AtomicTxSender.signEvmTransaction(users[3], erc20.getAddress(), encoded2);
        const delayed = async () => {
            await waitFor(0.23);
            AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signed2, admin);
            return AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signed, admin);
        }
        const results = await Promise.all([
            delayed(),
            baseCw20.transfer(admin.seiAddress, '100000')
        ]);
        const receipt = await rpcClient.getTransactionReceipt(results[0]);
        multipleSyntheticAndOneFailingEvmTx = results[1];
        expect(Number(receipt.blockNumber)).to.be.eq(results[1].height);
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx.height) -2),
            toBlock: ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx.height) + 2),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress().toString()
        };
        const logResponses = await rpcClient.sei_getLogs(logsParams);
        expect(logResponses.length).to.be.eq(0);
    });

    it('Sends multiple synthetic and multiple evm txs and validates logs', async () => {
        const signedTxs: string[] = [];
        for (let i = 0; i < 3; i++){
            const encoded = erc20.contract.interface.encodeFunctionData('transfer', [users[i].evmAddress, ethers.parseEther('0.01')]);
            signedTxs.push(await AtomicTxSender.signEvmTransaction(users[i], erc20.getAddress(), encoded));
        }
        const delayed = async () =>{
            await waitFor(0.25);
            return Promise.all(signedTxs.map((signedTx) => AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin)))
        }
        const msgs = [
            {contractAddress: baseCw20.getAddress(),
                msg: { transfer: { recipient: admin.seiAddress, amount: '100000' }}},
            {contractAddress: baseCw20.getAddress(),
                msg: { transfer: { recipient: admin.seiAddress, amount: '100000' }}}
        ];
        const results = await Promise.all([
            delayed(),
            baseCw20.execMultiple(msgs),
        ]);
        multipleSyntheticAndEvmTx = await rpcClient.getTransactionReceipt(results[0][0]);
        expect(Number(multipleSyntheticAndEvmTx.blockNumber)).to.be.eq(results[1].height);
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(multipleSyntheticAndEvmTx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(multipleSyntheticAndEvmTx.blockNumber) + 3),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress().toString()
        };
        const logs = await rpcClient.sei_getLogs(logsParams);
        expect(logs.length).to.be.greaterThan(0);
    });

    it('Can get logs for both erc20 and erc721 events', async () => {
        const deployer = new TokenDeployer(admin);
        const erc721 = await deployer.deployErc721('TestCw721', 'TestCw721', 'http://example.com');
        await (await erc721.safeMint(admin.evmAddress, '1')).wait();
        const encodedErc20 = erc20.contract.interface.encodeFunctionData('transfer', [users[0].evmAddress, ethers.parseEther('0.1')]);
        const signedErc20 = await AtomicTxSender.signEvmTransaction(users[1], erc20.getAddress(), encodedErc20);
        const encodedErc721 = erc721.contract.interface.encodeFunctionData('approve', [users[0].evmAddress, '1']);
        const signedErc721 = await AtomicTxSender.signEvmTransaction(admin, erc721.getAddress(), encodedErc721);
        const results= await Promise.all([
            AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedErc20, admin),
            AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedErc721, admin),
        ]);
        await waitFor(1);
        const tx = await rpcClient.getTransactionReceipt(results[0]);
        const logParams1 = {
            fromBlock: ethers.toQuantity(Number(tx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(tx.blockNumber) + 2),
            topics: [ethers.id('Approval(address,address,uint256)')],
        };
        const logs = await rpcClient.sei_getLogs(logParams1);
        const logParams2 = {
            fromBlock: ethers.toQuantity(Number(tx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(tx.blockNumber) + 2),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        };
        const logs2 = await rpcClient.sei_getLogs(logParams2);
        const combinedLogs = {
            fromBlock: ethers.toQuantity(Number(tx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(tx.blockNumber) + 2),
            topics: [[
                ethers.id('Transfer(address,address,uint256)'),
                ethers.id('Approval(address,address,uint256)')
            ]],
        };
        const logsCombined = await rpcClient.sei_getLogs(combinedLogs);
        expect(logsCombined.length).to.be.eq(logs.length + logs2.length);
    });

    it('Can return txs successfully for a span of 100 blocks', async () => {
        const encodedTx = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('0.01')]);
        const signedTxs = await Promise.all(users.map((user) => AtomicTxSender.signEvmTransaction(user, erc20.getAddress(), encodedTx)));
        const results = await Promise.all(signedTxs.map((signedTx) => AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin)));
        await waitFor(0.5);
        const txReceipt = await rpcClient.getTransactionReceipt(results[0]);
        multipleTxBlock = txReceipt.blockNumber;
        await waitFor(5); // Shorter wait for test speed
        const logParams = {
            fromBlock: txReceipt.blockNumber,
            toBlock: ethers.toQuantity(Number(txReceipt.blockNumber) + 100),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress().toString(),
        };
        const logResponses = await rpcClient.sei_getLogs(logParams);
        expect(logResponses.length).to.be.eq(users.length);
        let txIndexes = new Set();
        let logIndexes = new Set();
        const expectedLogIndexes = new Array(users.length).fill(0)
            .map((_, index) => ethers.toQuantity(index));
        for(const topic of logResponses) {
            expect(topic.address.toString().toLowerCase()).to.be.eq(erc20.getAddress().toString().toLowerCase());
            const parsed = erc20.contract.interface.parseLog(topic) as LogDescription;
            expect(parsed.name).to.be.eq('Transfer');
            expect(parsed.args[1]).to.equal(admin.evmAddress);
            expect(ethers.formatEther(parsed.args[2].toString())).to.equal('0.01')
            txIndexes.add(topic.transactionIndex);
            logIndexes.add(topic.logIndex);
            expect(topic.logIndex).to.be.oneOf(expectedLogIndexes);
        }
        expect(txIndexes.size).to.be.eq(users.length);
        expect(logIndexes.size).to.be.eq(users.length);
    });

    it('Sei get logs supports finalized, safe, latest, pending tags', async () => {
        let i = 0;
        const tags = ['finalized', 'safe', 'latest', 'pending'];
        for(const tag of tags) {
            await waitFor(2);
            await baseCw20.transfer(admin.seiAddress, users[i].seiAddress, '1000');
            let index = 0;
            let found = false;
            while(index < 200){
                const logParams = {
                    fromBlock: tag,
                    topics: [ethers.id('Transfer(address,address,uint256)')],
                    address: erc20.getAddress().toString(),
                };
                const rpc = await rpcClient.sei_getLogs(logParams);
                if(rpc.length > 0){
                    i++;
                    found = true;
                    break;
                } else {
                    await waitFor(0.02);
                    index++;
                }
            }
            expect(found).to.be.true;
        }
    });
});

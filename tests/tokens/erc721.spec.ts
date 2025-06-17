import {TestNFT, TestNFT__factory} from '../typechain-types';
import {ContractTransactionReceipt, ethers} from 'ethers';
import contractArtifacts from '../artifacts/contracts/TestNFT.sol/TestNFT.json';
import {SeiUser} from '../../modules/utils/User';
import testConfig from '../testConfig.json';
import {Funder} from '../../modules/utils/Funder';
import RPCClient from '../utils/RPCClient';
import {waitFor} from '../../modules/tokenfactory/helpers';
import util from 'node:util';
import {queryErc721PointerContractAddress} from '../utils/cosmosUtils';
import Hardhat from '../utils/Hardhat';

const exec = util.promisify(require('node:child_process').exec);

describe('ERC721 Pointers Tests', function () {
    /**
     * Deploys erc721 contract. Checks mint, transfer, burn functions with rpc events. Deploys a pointer and executes txs
     */
    this.timeout(10 * 60 * 1000);
    let erc721Contract: TestNFT;
    let cwPointerAddress: string;
    let alice: SeiUser;
    let bob: SeiUser;
    let funder: Funder;
    let expect: Chai.ExpectStatic;
    let rpcClient: RPCClient;

    before('Deploys erc721 contract', async () => {
        alice = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
        bob = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
        await alice.initialize('', 'alice', false);
        await bob.initialize('', 'bob', false);
        funder = new Funder(alice.seiAddress);
        await funder.fundAddressOnSei(alice.seiAddress);
        await waitFor(1);
        await funder.fundAddressOnSei(bob.seiAddress);
        await alice.seiWallet.associate();
        await bob.seiWallet.associate();
        rpcClient = new RPCClient(alice.evmWallet.signingClient);

        const erc721ContractFactory = new ethers.ContractFactory(contractArtifacts.abi, contractArtifacts.bytecode, alice.evmWallet.wallet) as TestNFT__factory;
        erc721Contract = await erc721ContractFactory.deploy(alice.evmAddress);
        await erc721Contract.waitForDeployment();
        console.info('ERC 721 contract deployed to address ', await erc721Contract.getAddress());
        const chai = await import('chai');
        expect = chai.expect;
    });

    let mintTxReceipt: ContractTransactionReceipt;

    it.only('Alice mints an nft on evm runtime before pointer deployment', async () => {
        const mintTx = await erc721Contract.safeMint(alice.evmAddress, '1');
        mintTxReceipt = await mintTx.wait() as ContractTransactionReceipt;
        //Validate that the nft is minted
        const ownerInfo = await erc721Contract.ownerOf('1');
    });

    it.only('Alice can see the nft mint event with eth_getLogs', async () => {
        const logParams = {
            fromBlock: ethers.toQuantity(mintTxReceipt.blockNumber - 2),
            toBlock: ethers.toQuantity(mintTxReceipt.blockNumber + 3),
            address: await erc721Contract.getAddress(),
        };
        const logs = await rpcClient.eth_getLogs(logParams);
        expect(logs.length).to.be.greaterThan(0, 'No logs found for the mint transaction');
        const parsedLogs = logs
            .map((log: { topics: ReadonlyArray<string>; data: string; }) => {
                try {
                    return erc721Contract.interface.parseLog(log);
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);
        expect(parsedLogs).to.not.be.empty;

        const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
        expect(transferEvent).to.exist;
        expect(transferEvent.args.from).to.equal(ethers.ZeroAddress);
        expect(transferEvent.args.to).to.equal(alice.evmAddress);
        expect(transferEvent.args.tokenId.toString()).to.equal('1');
    });

    it.only('Alice can see the nft mint event with sei_getLogs', async () => {
        const logParams = {
            fromBlock: ethers.toQuantity(mintTxReceipt.blockNumber - 2),
            toBlock: ethers.toQuantity(mintTxReceipt.blockNumber + 3),
            address: await erc721Contract.getAddress(),
        };
        const logs = await rpcClient.sei_getLogs(logParams);
        expect(logs.length).to.be.greaterThan(0, 'No logs found for the mint transaction');

        const parsedLogs = logs
            .map((log: { topics: ReadonlyArray<string>; data: string; }) => {
                try {
                    return erc721Contract.interface.parseLog(log);
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);

        expect(parsedLogs).to.not.be.empty;

        const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
        expect(transferEvent).to.exist;
        expect(transferEvent.args.from).to.equal(ethers.ZeroAddress);
        expect(transferEvent.args.to).to.equal(alice.evmAddress);
        expect(transferEvent.args.tokenId.toString()).to.equal('1');
    });

    it.only('Alice can see the nft mint event with eth_getBlocksByNumber with tx details full', async () => {
        const block = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(mintTxReceipt.blockNumber), true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');

        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'safeMint');
        expect(logs![0]).to.be.eq(alice.evmAddress);
        expect(logs![1]).to.be.eq(BigInt('1'));
    });

    it.only('Alice can see the nft mint event with eth_getBlocksByNumber with tx details minimal', async () => {
        const block = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(mintTxReceipt.blockNumber), false);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
    })

    it.only('Alice can see the nft mint event with sei_getBlocksByNumber', async () => {
        const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(mintTxReceipt.blockNumber), true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');

        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'safeMint');
        expect(logs![0]).to.be.eq(alice.evmAddress);
        expect(logs![1]).to.be.eq(BigInt('1'));
    });

    it.only('Alice can see the nft mint event with eth_getBlocksByHash', async () => {
        const block = await rpcClient.eth_getBlockByHash(mintTxReceipt.blockHash, true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');

        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'safeMint');
        expect(logs![0]).to.be.eq(alice.evmAddress);
        expect(logs![1]).to.be.eq(BigInt('1'));
    });

    it.only('Alice can see the nft mint event with sei_getBlocksByHash', async () => {
        const block = await rpcClient.sei_getBlockByHash(mintTxReceipt.blockHash, true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');

        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'safeMint');
        expect(logs![0]).to.be.eq(alice.evmAddress);
        expect(logs![1]).to.be.eq(BigInt('1'));
    });

    it.only('Alice can see the nft mint event with eth_getTransactionReceipt', async () => {
        const receipt = await rpcClient.eth_getTransactionReceipt(mintTxReceipt.hash);
        expect(receipt).to.not.be.null;
        expect(receipt.logs.length).to.be.greaterThan(0, 'No logs found in the transaction receipt');
        expect(receipt.status).to.be.eq(ethers.toQuantity(1), 'Transaction did not succeed');
        expect(receipt.to.toLowerCase()).to.be.eq((await erc721Contract.getAddress()).toLowerCase());
    });

    let failedTxBlockNumber: number;
    let failedTxBlockHash: string;
    let failedTxHash: string;

    it.only('Alice can try to mint an already mined nft and the tx is going to fail', async () => {
        const data = erc721Contract.interface.encodeFunctionData('safeMint', [alice.evmAddress, '1']);
        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const chainId = (await alice.evmWallet.signingClient.getNetwork()).chainId;

        // For EIP-1559 Transactions
        const maxFeePerGas = ethers.parseUnits('100', 'gwei');
        const maxPriorityFeePerGas = ethers.parseUnits('2', 'gwei');

        const gasLimit = ethers.toBeHex('100000');

        const tx = {
            nonce: nonce,
            to: await erc721Contract.getAddress(),
            value: '0x0',
            data: data,
            gasLimit: gasLimit,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas,
            type: 2,
            chainId: chainId,
        };

        const signedTx = await alice.evmWallet.wallet.signTransaction(tx);
        try{
            const txResponse = await alice.evmWallet.signingClient.broadcastTransaction(signedTx);
            const receipt = await txResponse.wait();
        } catch(e: any){
            failedTxBlockNumber = parseInt(e.message.slice(e.message.indexOf("blockNumber") + 13).slice(0, e.message.indexOf(",")).trim());
            failedTxBlockHash = e.message.slice(e.message.indexOf("blockHash") + 13).slice(0, 66).trim();
            failedTxHash = e.message.slice(e.message.indexOf("hash") + 8).slice(0, 66).trim();
        }
        const blockResult = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(failedTxBlockNumber), true);
        rpcClient.validateEth_getBlockByNumberCall(blockResult, erc721Contract, 1, expect, 'safeMint');
    });

    it.only('Alice will see the failed tx event on eth_getBlocksByNumber', async () => {
        const blockResult = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(failedTxBlockNumber), true);
        rpcClient.validateEth_getBlockByNumberCall(blockResult, erc721Contract, 1, expect, 'safeMint');
    });

    it.only('Alice will see the failed tx event on sei_getBlocksByNumber', async () => {
        const blockResult = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(failedTxBlockNumber), true);
        rpcClient.validateEth_getBlockByNumberCall(blockResult, erc721Contract, 1, expect, 'safeMint');
    });

    it.only('Alice will see the failed tx event on eth_getBlocksByHash', async () => {
        const blockResult = await rpcClient.eth_getBlockByHash(failedTxBlockHash, true);
        rpcClient.validateEth_getBlockByNumberCall(blockResult, erc721Contract, 1, expect, 'safeMint');
    });

    it.only('Alice will see the failed tx event on sei_getBlocksByHash', async () => {
        const blockResult = await rpcClient.eth_getBlockByHash(failedTxBlockHash, true);
        rpcClient.validateEth_getBlockByNumberCall(blockResult, erc721Contract, 1, expect, 'safeMint');
    });

    it.only('Alice will see the failed tx event on eth_getTransactionReceipt', async () => {
        const receipt = await rpcClient.eth_getTransactionReceipt(failedTxHash);
        expect(receipt).to.not.be.null;
        expect(receipt.status).to.equal(ethers.toQuantity(0), 'Transaction did not fail');
    });

    let transferTxReceipt: ContractTransactionReceipt;

    it.only('Alice can mint an nft on evm runtime and calls safe transfer to Bob', async () =>{
        const mintTx = await erc721Contract.safeMint(alice.evmAddress, '2');
        mintTxReceipt = await mintTx.wait() as ContractTransactionReceipt;

        //Alice transfers to Bob
        const transferTx = await erc721Contract.transferFrom(alice.evmAddress, bob.evmAddress, '2');
        transferTxReceipt = await transferTx.wait() as ContractTransactionReceipt;

        //Validate transfers
        const bobToken = await erc721Contract.ownerOf('2');
        console.log(`Bob address is ${bob.evmAddress}, and token owner is ${bobToken}`);
    });

    it.only('Alice can see the nft transfer event with eth_getLogs', async () => {
        const logParams = {
            fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
            toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 3),
            address: await erc721Contract.getAddress(),
        };
        const logs = await rpcClient.eth_getLogs(logParams);
        expect(logs.length).to.be.greaterThan(0, 'No logs found for the transfer transaction');

        const parsedLogs = logs
            .map((log: { topics: ReadonlyArray<string>; data: string; }) => {
                try {
                    return erc721Contract.interface.parseLog(log);
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);

        expect(parsedLogs).to.not.be.empty;

        const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
        expect(transferEvent).to.exist;
        expect(transferEvent.args.from).to.equal(alice.evmAddress);
        expect(transferEvent.args.to).to.equal(bob.evmAddress);
        expect(transferEvent.args.tokenId.toString()).to.equal('2');
    });

    it.only('Alice can see the nft transfer event with sei_getLogs', async () => {
        const logParams = {
            fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
            toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 3),
            address: await erc721Contract.getAddress(),
        };
        const logs = await rpcClient.sei_getLogs(logParams);
        expect(logs.length).to.be.greaterThan(0, 'No logs found for the transfer transaction');

        const parsedLogs = logs
            .map((log: { topics: ReadonlyArray<string>; data: string }) => {
                try {
                    return erc721Contract.interface.parseLog(log);
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);

        expect(parsedLogs).to.not.be.empty;

        const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
        expect(transferEvent).to.exist;
        expect(transferEvent.args.from).to.equal(alice.evmAddress);
        expect(transferEvent.args.to).to.equal(bob.evmAddress);
        expect(transferEvent.args.tokenId.toString()).to.equal('2');
    });

    it.only('Alice can see the nft transfer event with eth_getBlocksByNumber with tx details full', async () => {
        const block = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'transferFrom');
        expect(logs![0]).to.be.eq(alice.evmAddress);
        expect(logs![1]).to.be.eq(bob.evmAddress);
        expect(logs![2]).to.be.eq(BigInt('2'));
    });

    it.only('Alice can see the nft transfer event with eth_getBlocksByNumber with tx details minimal', async () => {
        const block = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), false);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
    });

    it.only('Alice can see the nft transfer event with sei_getBlocksByNumber', async () => {
        const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');

        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'transferFrom');
        expect(logs![0]).to.be.eq(alice.evmAddress);
        expect(logs![1]).to.be.eq(bob.evmAddress);
        expect(logs![2]).to.be.eq(BigInt('2'));
    });

    it.only('Alice can see the nft transfer event with eth_getBlocksByHash', async () => {
        const block = await rpcClient.eth_getBlockByHash(transferTxReceipt.blockHash, true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');

        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'transferFrom');
        expect(logs![0]).to.be.eq(alice.evmAddress);
        expect(logs![1]).to.be.eq(bob.evmAddress);
        expect(logs![2]).to.be.eq(BigInt('2'));
    });

    it.only('Alice can see the nft transfer event with sei_getBlocksByHash', async () => {
        const block = await rpcClient.sei_getBlockByHash(transferTxReceipt.blockHash, true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');

        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'transferFrom');
        expect(logs![0]).to.be.eq(alice.evmAddress);
        expect(logs![1]).to.be.eq(bob.evmAddress);
        expect(logs![2]).to.be.eq(BigInt('2'));
    });

    it.only('Alice can see the nft transfer event with eth_getTransactionReceipt', async () => {
        const receipt = await rpcClient.eth_getTransactionReceipt(transferTxReceipt.hash);
        expect(receipt).to.not.be.null;
        expect(receipt.logs.length).to.be.greaterThan(0, 'No logs found in the transaction receipt');
        expect(receipt.status).to.be.eq(ethers.toQuantity(1), 'Transaction did not succeed');
        expect(receipt.to.toLowerCase()).to.be.eq((await erc721Contract.getAddress()).toLowerCase());
    });

    it.only('Given that there are multiple txs in the same block (Alice mints another nft and bob sends nft back to alice), Alice can see the nft transfer event with eth_getLogs', async () => {
        const [mintTx, transferTx] = await Promise.all([
            erc721Contract.safeMint(alice.evmAddress, '3'),
            erc721Contract.connect(bob.evmWallet.wallet).transferFrom(bob.evmAddress, alice.evmAddress, '2')
        ]);

        ([mintTxReceipt, transferTxReceipt] = await Promise.all([mintTx.wait(), transferTx.wait()]) as ContractTransactionReceipt[]);
        console.log(mintTxReceipt, transferTxReceipt);
        const logParams = {
            fromBlock: ethers.toQuantity(transferTxReceipt!.blockNumber - 2),
            toBlock: ethers.toQuantity(transferTxReceipt!.blockNumber + 3),
            address: await erc721Contract.getAddress(),
        };

        const logs = await rpcClient.eth_getLogs(logParams);
        expect(logs.length).to.be.eq(2, 'No logs found for the transactions');
    });

    it.only('Given that there are multiple txs in the same block Alice can see the nft transfer event with sei_getLogs', async () => {
        const logParams = {
            fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
            toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 3),
            address: await erc721Contract.getAddress(),
        };

        const logs = await rpcClient.sei_getLogs(logParams);
        expect(logs.length).to.be.greaterThan(1, 'No logs found for the transactions');
    });

    it.only('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getBlocksByNumber with tx details full', async () => {
        const block = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
        expect(block.transactions.length).to.be.greaterThan(1, 'Expected multiple transactions in the block');
    });

    it.only('Given that there are multiple txs in the same block Alice can see the nfGiven that there are multiple txs in the same block Alice can see the nft transfer event with eth_getBlocksByNumber with tx details minimalt transfer event with eth_getBlocksByNumber with tx details minimal', async () => {
        const block = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), false);
        console.log(block);
        expect(block.transactions.length).to.be.greaterThan(1, 'Expected multiple transactions in the block');
    });

    it.only('Given that there are multiple txs in the same block Alice can see the nft transfer event with sei_getBlocksByNumber', async () => {
        const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
        expect(block.transactions.length).to.be.greaterThan(1, 'Expected multiple transactions in the block');
    });

    it.only('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getBlocksByHash', async () => {
        const block = await rpcClient.eth_getBlockByHash(transferTxReceipt.blockHash, true);
        expect(block.transactions.length).to.be.greaterThan(1, 'Expected multiple transactions in the block');
    });

    it.only('Given that there are multiple txs in the same block Alice can see the nft transfer event with sei_getBlocksByHash', async () => {
        const block = await rpcClient.sei_getBlockByHash(transferTxReceipt.blockHash, true);
        console.log(block);
        expect(block.transactions.length).to.be.greaterThan(1, 'Expected multiple transactions in the block');
    });

    it.only('Given that there are multiple txs in the same block Alice can see the nft transfer event with eth_getTransactionReceipt', async () => {
        const receipt = await rpcClient.eth_getTransactionReceipt(transferTxReceipt.hash);
        expect(receipt).to.not.be.null;
        expect(receipt.logs.length).to.be.greaterThan(0, 'No logs found in the transaction receipt');
        expect(receipt.status).to.be.eq(ethers.toQuantity(1), 'Transaction did not succeed');
    });

    let approvalTxReceipt: ContractTransactionReceipt;
    it.only('Alice can approve nft rights to Bob on evm runtime', async () => {
        const approvalTx = await erc721Contract.approve(bob.evmAddress, '2');
        approvalTxReceipt = await approvalTx.wait() as ContractTransactionReceipt;

        // Validate approval
        const approvedAddress = await erc721Contract.getApproved('2');
        expect(approvedAddress).to.equal(bob.evmAddress, 'NFT was not approved for Bob');
    });

    it.only('Alice can see nft approve event with eth_getLogs', async () => {
        const logParams = {
            fromBlock: ethers.toQuantity(approvalTxReceipt.blockNumber - 2),
            toBlock: ethers.toQuantity(approvalTxReceipt.blockNumber + 2),
            address: await erc721Contract.getAddress(),
        };

        const logs = await rpcClient.eth_getLogs(logParams);
        expect(logs.length).to.be.greaterThan(0, 'No logs found for the approval transaction');

        const parsedLogs = logs
            .map((log: { topics: ReadonlyArray<string>; data: string }) => {
                try {
                    return erc721Contract.interface.parseLog(log);
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);

        expect(parsedLogs).to.not.be.empty;

        const approvalEvent = parsedLogs.find((e) => e.name === 'Approval');
        expect(approvalEvent).to.exist;
        expect(approvalEvent.args.owner).to.equal(alice.evmAddress);
        expect(approvalEvent.args.approved).to.equal(bob.evmAddress);
        expect(approvalEvent.args.tokenId.toString()).to.equal('2');
    });

    it.only('Alice can see nft approve event with sei_getLogs', async () => {
        const logParams = {
            fromBlock: ethers.toQuantity(approvalTxReceipt.blockNumber - 2),
            toBlock: ethers.toQuantity(approvalTxReceipt.blockNumber + 2),
            address: await erc721Contract.getAddress(),
        };

        const logs = await rpcClient.sei_getLogs(logParams);
        expect(logs.length).to.be.greaterThan(0, 'No logs found for the approval transaction');

        const parsedLogs = logs
            .map((log: { topics: ReadonlyArray<string>; data: string }) => {
                try {
                    return erc721Contract.interface.parseLog(log);
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);

        expect(parsedLogs).to.not.be.empty;

        const approvalEvent = parsedLogs.find((e) => e.name === 'Approval');
        expect(approvalEvent).to.exist;
        expect(approvalEvent.args.owner).to.equal(alice.evmAddress);
        expect(approvalEvent.args.approved).to.equal(bob.evmAddress);
        expect(approvalEvent.args.tokenId.toString()).to.equal('2');
    });

    it.only('Alice can see nft approve event with eth_getBlocksByNumber', async () => {
        const block = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(approvalTxReceipt.blockNumber), true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');
        console.log(block);
        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'approve');

        expect(logs![0]).to.be.eq(bob.evmAddress);
        expect(logs![1]).to.be.eq(BigInt('2'));
    });

    it.only('Alice can see nft approve event with sei_getBlocksByNumber', async () => {
        const block = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(approvalTxReceipt.blockNumber), true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');

        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'approve');
        expect(logs![0]).to.be.eq(bob.evmAddress);
        expect(logs![1]).to.be.eq(BigInt('2'));
    });

    let eve: SeiUser;

    it.only('Bob can actually transfer nft that he has been authorized to', async () => {
        console.log(await erc721Contract.getApproved('2'));
        console.log(bob.evmAddress);
        console.log(await erc721Contract.ownerOf('2'));
        console.log(await bob.evmWallet.queryBalance());
        eve = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
        await eve.initialize('', 'eve', true);
        await funder.fundAddressOnSei(eve.seiAddress);
        await eve.seiWallet.associate();
        await waitFor(1);

        const transferTx = await erc721Contract.connect(bob.evmWallet.wallet).transferFrom(alice.evmAddress, eve.evmAddress, '2');
        transferTxReceipt = await transferTx.wait() as ContractTransactionReceipt;

        // Validate transfer
        const newOwner = await erc721Contract.ownerOf('2');
        expect(newOwner).to.equal(eve.evmAddress, 'NFT was not transferred to Bob');
    });

    it.only('Bobs transfer will appear correctly on eth_getLogs', async () => {
        const logParams = {
            fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
            toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 2),
            address: await erc721Contract.getAddress(),
        };

        const logs = await rpcClient.eth_getLogs(logParams);
        expect(logs.length).to.be.greaterThan(0, 'No logs found for the transfer transaction');

        const parsedLogs = logs
            .map((log: { topics: ReadonlyArray<string>; data: string }) => {
                try {
                    return erc721Contract.interface.parseLog(log);
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);

        expect(parsedLogs).to.not.be.empty;

        const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
        expect(transferEvent).to.exist;
        expect(transferEvent.args.from).to.equal(alice.evmAddress);
        expect(transferEvent.args.to).to.equal(eve.evmAddress);
        expect(transferEvent.args.tokenId.toString()).to.equal('2');
    });

    it.only('Bobs transfer will appear correctly on sei_getLogs', async () => {
        const logParams = {
            fromBlock: ethers.toQuantity(transferTxReceipt.blockNumber - 2),
            toBlock: ethers.toQuantity(transferTxReceipt.blockNumber + 2),
            address: await erc721Contract.getAddress(),
        };

        const logs = await rpcClient.sei_getLogs(logParams);
        expect(logs.length).to.be.greaterThan(0, 'No logs found for the transfer transaction');

        const parsedLogs = logs
            .map((log: { topics: ReadonlyArray<string>; data: string }) => {
                try {
                    return erc721Contract.interface.parseLog(log);
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean);

        expect(parsedLogs).to.not.be.empty;

        const transferEvent = parsedLogs.find((e) => e.name === 'Transfer');
        expect(transferEvent).to.exist;
        expect(transferEvent.args.from).to.equal(alice.evmAddress);
        expect(transferEvent.args.to).to.equal(eve.evmAddress);
        expect(transferEvent.args.tokenId.toString()).to.equal('2');
    });

    it.only('Bobs transfer will appear correctly on eth_getBlocksByNumber', async () => {
        const block = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(transferTxReceipt.blockNumber), true);
        expect(block.transactions.length).to.be.greaterThan(0, 'No transactions found in the block');

        const logs = rpcClient.validateEth_getBlockByNumberCall(block, erc721Contract, 1, expect, 'transferFrom');
        expect(logs![0]).to.be.eq(alice.evmAddress);
        expect(logs![1]).to.be.eq(eve.evmAddress);
        expect(logs![2]).to.be.eq(BigInt('2'));
    });

    it.only('Alice mints another nft and approves for Bob, but Eve cant transfer nft from alice', async () => {
        // Alice mints another NFT (tokenId: 4)
        const mintTx = await erc721Contract.safeMint(alice.evmAddress, '4');
        await mintTx.wait();

        // Alice approves Bob for the minted NFT
        const approvalTx = await erc721Contract.approve(bob.evmAddress, '4');
        await approvalTx.wait();

        // Ensure that Bob is actually approved
        const approvedForToken = await erc721Contract.getApproved('4');
        expect(approvedForToken).to.equal(bob.evmAddress, 'Bob was not approved to transfer NFT');
        console.log(approvedForToken);
        // Eve tries to transfer NFT from Alice but should fail
        try{
            await erc721Contract.connect(eve.evmWallet.wallet).transferFrom(alice.evmAddress, eve.evmAddress, '4')
        } catch (e: any){
            console.log(e.message);
        }
    });

    let pointerAddress: string;

    it.only('Alice deploys a pointer for erc721 on cosmos runtime', async () => {
        const {stdout} = await exec(`seid tx evm register-cw-pointer ERC721 ${await erc721Contract.getAddress()} --from admin --fees 24200usei --broadcast-mode block -y`);
        await waitFor(1);
        console.log(stdout);
        pointerAddress = await queryErc721PointerContractAddress(await erc721Contract.getAddress());
        console.log(pointerAddress);
    });

    it.only('Alice cant deploy the pointer for the same ERC721 address', async () => {
        const {stdout} = await exec(`seid tx evm register-cw-pointer ERC721 ${await erc721Contract.getAddress()} --from admin --fees 24200usei --broadcast-mode block -y`);
        expect(stdout).to.contain('already registered at version 6');

        const pointerAddressTry = await queryErc721PointerContractAddress(await erc721Contract.getAddress());
        expect(pointerAddressTry).to.equal(pointerAddress);
    });

    it.only('Alice can read pointer info on cosmos runtime for the pointer', async () => {
        const tokenName = await alice.seiWallet.cosmWasmSigningClient.queryContractSmart(pointerAddress, {contract_info: {}});
        console.log(tokenName);
    });

    it.only('Alice can query the token info of eve on the cosmos runtime', async () => {
        const tokenInfo = await alice.seiWallet.cosmWasmSigningClient.queryContractSmart(
            pointerAddress,
            {owner_of: {token_id: '2'}}
        );
        expect(tokenInfo.owner).to.equal(eve.seiAddress, 'Eve does not own the token in Cosmos runtime');
        console.log(tokenInfo);
    });

    it.only('Alice can query the total issuance of erc721 token on cosmos runtime', async () => {
        console.log(pointerAddress);
        const totalIssuance = await alice.seiWallet.cosmWasmSigningClient.queryContractSmart(pointerAddress, {all_tokens: {}});
        expect(totalIssuance.count).to.be.greaterThan(0, 'Total issuance is incorrect');
        console.log(totalIssuance);
    });

    it.only('Alice can query the ownership of a token on the cosmos runtime', async () => {
        const tokenInfo = await alice.seiWallet.cosmWasmSigningClient.queryContractSmart(
            pointerAddress,
            {owner_of: {token_id: '4'}}
        );
        expect(tokenInfo.owner).to.equal(alice.seiAddress, 'Alice does not own the token in Cosmos runtime');
        console.log(tokenInfo);
    });

    it.only('Queries stuff', async () =>{
        const allTokens = await alice.seiWallet.cosmWasmSigningClient.queryContractSmart(
            pointerAddress,
            { all_tokens: {} }
        );
        console.log(allTokens);

        const all = await alice.seiWallet.cosmWasmSigningClient.queryContractSmart(
            pointerAddress,
            {num_tokens: {}}
        )
        console.log(all);

        const allNftDetails = await alice.seiWallet.cosmWasmSigningClient.queryContractSmart(
            pointerAddress,
            { all_nft_info: { token_id: "4" } }
        );
        console.log(allNftDetails);

        const contractInfo = await alice.seiWallet.cosmWasmSigningClient.queryContractSmart(
            pointerAddress,
            { contract_info: {} }
        );
        console.log(contractInfo);

        const tokenApprovals = await alice.seiWallet.cosmWasmSigningClient.queryContractSmart(
            pointerAddress,
            { approvals: { token_id: "4" } }
        );
        console.log(tokenApprovals);

        const totalSupply = await erc721Contract.totalSupply();
        console.log(totalSupply);
    });

    it.only('Alice can transfer a token on cosmos runtime and query on evm runtime', async () => {
        // Transfer token from Alice to Eve on Cosmos runtime
        await alice.seiWallet.cosmWasmSigningClient.execute(
            alice.seiAddress,
            pointerAddress,
            {transfer_nft: {recipient: eve.seiAddress, token_id: '4'}},
            'auto'
        );

        // Query ownership in EVM runtime
        const newOwner = await erc721Contract.ownerOf('4');
        expect(newOwner).to.equal(eve.evmAddress, 'Token transfer is not reflected in EVM runtime');
    });

    it.only('Eve can approve token id 4 for eve address and query approval on evm runtime', async () => {
        const tx = await eve.seiWallet.cosmWasmSigningClient.execute(
            eve.seiAddress,
            pointerAddress,
            {approve: {spender: alice.seiAddress, token_id: '4'}},
            'auto'
        );
        // Query approval in EVM runtime
        const approvedForToken = await erc721Contract.getApproved('4');
        expect(approvedForToken).to.equal(alice.evmAddress, 'Approval is not reflected in EVM runtime');
    });

    it.only('Alice cannot register a pointer with an invalid ERC721 address', async () => {
        const invalidAddress = '0x0000000000000000000000000000000000000000';
        const { stdout } = await exec(`seid tx evm register-cw-pointer ERC721 ${invalidAddress} --from admin --fees 24200usei --broadcast-mode block -y`);
        console.log(stdout);
    });

    it.only('Alice cannot register a pointer with a malformed ERC721 address', async () =>{
        try{
            const invalidAddress = '0x000000000000000000000000';
            const { stdout } = await exec(`seid tx evm register-cw-pointer ERC721 ${invalidAddress} --from admin --fees 24200usei --broadcast-mode block -y`);
        } catch (e: any) {
            expect(e.message).to.contain('invalid address');
        }
    });

    it('Nft transfer event from eth_getBlockNumber matches hardhat eth_GetBlockNumber', async () => {
        // Deploy to hardhat
        console.info('Running hardhat port');
        const hardhat = new Hardhat('8595');
        // Initialize hardhat node
        hardhat.initializeHardhat();

        await hardhat.deployErc721();
        const erc721HH = hardhat.erc721;

        const mintTxHH = await erc721HH.safeMint(hardhat.hardhatOwner.address, '100');
        const minTxSei = await erc721Contract.safeMint(alice.evmAddress, '100');

        const receiptHh = await mintTxHH.wait();
        const receiptSei = await minTxSei.wait();

        const hhProvider = hardhat.returnHardhatProvider();
        const hhRpcResponse = await hhProvider.send('eth_getBlockByNumber', [receiptHh?.blockNumber, true]);
        const seiRpcResponse = await rpcClient.eth_getBlockByNumber(ethers.toQuantity(receiptSei!.blockNumber), true);
        const seiRpcResponseSei = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(receiptSei!.blockNumber), true);
        hardhat.validateBlocks(hhRpcResponse, seiRpcResponse, expect);
        hardhat.validateBlocks(hhRpcResponse, seiRpcResponseSei, expect);

        const hhRpcResponseForBlockHash = await hhProvider.send('eth_getBlockByHash', [receiptHh?.blockHash, true]);
        const seiRpcResponseForBlockHash = await rpcClient.eth_getBlockByHash(receiptSei!.blockHash, true);
        const seiRpcResponseForBlockHashSei = await rpcClient.sei_getBlockByHash(receiptSei!.blockHash, true);

        hardhat.validateBlocks(hhRpcResponseForBlockHash, seiRpcResponseForBlockHash, expect);
        hardhat.validateBlocks(hhRpcResponseForBlockHash, seiRpcResponseForBlockHashSei, expect);
        hardhat.stopNode();
    });
});

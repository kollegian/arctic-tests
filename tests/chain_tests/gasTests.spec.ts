import {ethers, TransactionReceipt} from "ethers";
import {SeiUser, UserFactory} from "../../shared/User";
import {Erc20Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import {EvmRpcClient} from "../../shared/RpcClient";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {expect} from "chai";
import testConfig from "../../config/testConfig.json";
import {RealGasBurner} from "../../typechain-types";
import fs from "fs";
import heavyGasAbi from "../../artifacts/contracts/GasBurner.sol/RealGasBurner.json";
import {getBaseFeePerBlock} from "./utils";
import {calcNewBaseFee, waitFor} from "../../shared/utils/helpers";

describe('Gas tests', function () {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;

    let cw20Contract: Erc20Token;
    let erc20Contract: Erc20Token;
    let gasBurnerContract: RealGasBurner;
    let rpcClient: EvmRpcClient;
    let chainId: bigint;

    before('Initializes client', async () => {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        [alice, bob] = await UserFactory.createSeiUsers(admin, 2, true);
        const contractFactory = new ethers.ContractFactory(heavyGasAbi.abi, heavyGasAbi.bytecode, alice.evmWallet.wallet);
        const deploymentTx = await contractFactory.deploy();
        gasBurnerContract = await deploymentTx.waitForDeployment() as unknown as RealGasBurner;
        // Initialize RPC client
        rpcClient = new EvmRpcClient(testConfig.evmRpcEndpoint, admin.evmWallet.signingClient);
        chainId = (await alice.evmWallet.signingClient.getNetwork()).chainId;
        
        // Load contract addresses dynamically at runtime
        const contractAddresses = JSON.parse(fs.readFileSync('./tests/tokens/contractAddresses.json', 'utf8'));
        erc20Contract = new Erc20Token(admin, contractAddresses.erc20Address);
    
        console.log('Gas Burner contract deployed to:', gasBurnerContract.target);
        console.log('ERC20 contract deployed to:', erc20Contract.getAddress());
    });

    it('Users can send legacy txs and the gas fee charges specified amount', async () => {
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('0.1')]
        );
        const senderPreSeiBalance = await rpcClient.getBalance(alice.evmAddress);
        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const gasPrice = 1200000000n;
        const gasLimit = 500000n;
        
        const txRequest = {
            to: erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit: gasLimit,
            gasPrice: gasPrice,
            nonce: nonce,
            chainId: chainId,
            type: 0
        };
        
        const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
        const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
            alice.evmWallet.signingClient,
            signedTx
        );
        console.log(txHash);
        const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
        expect(receipt?.status).to.be.eq(1);
        expect(receipt?.type).to.be.eq(0);

        // Verify correct gas fee returned
        if (receipt?.gasPrice !== undefined && receipt?.gasUsed !== undefined) {
            expect(Number(receipt.gasUsed)).to.be.lt(Number(gasLimit));
            expect(Number(receipt.gasPrice)).to.be.eq(Number(gasPrice));
            
            // Verify correct gas fee taken from the user
            const senderAfterBalance = await rpcClient.getBalance(alice.evmAddress);
            const senderBalanceDiff = Number(ethers.formatEther(senderPreSeiBalance - senderAfterBalance));
            const userPaidGasFee = Number(ethers.formatEther(receipt.gasPrice * receipt.gasUsed));
            expect(senderBalanceDiff).to.be.eq(userPaidGasFee);
        } else {
            throw new Error('receipt.gasPrice or receipt.gasUsed is undefined');
        }
    });

    it('Users can send legacy txs with insufficient gas limit and tx fails', async () => {
        // Use debug contract to create a transaction that will consume more gas than the limit
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('1')]
        );
        
        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const insufficientGasLimit = 1000n;
        
        const txRequest = {
            to: erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit: insufficientGasLimit,
            gasPrice: 1000000000n,
            nonce: nonce,
            chainId: chainId,
            type: 0
        };

        let failed = false;
        try {
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                alice.evmWallet.signingClient, signedTx
            );
            const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
            expect(receipt?.status).to.not.be.eq(1);
        } catch (err: any) {
            failed = true;
        }
        expect(failed).to.be.true;
    });

    it('Users can send legacy txs with gas fee below base fee and tx fails', async () => {
        // Block base gas fee is 1000000000, so use 900000000 (below base)
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('1')]
        );
        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const lowGasPrice = 999999999n;
        
        const txRequest = {
            to: erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit: 500000n,
            gasPrice: lowGasPrice,
            nonce: nonce,
            chainId: chainId,
            type: 0
        };
        
        let failed = false;
        try {
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                alice.evmWallet.signingClient, signedTx
            );
            const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
            expect(receipt?.status).to.not.be.eq(1);
        } catch (err: any) {
            failed = true;
        }
        expect(failed).to.be.true;
    });

    it('Users can send type 2 txs and correct gas fee is charged', async () => {
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('0.1')]
        );
        
        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const maxFeePerGas = 5000000000;
        const maxPriorityFeePerGas = 1000000000;
        const senderPreSeiBalance = await rpcClient.getBalance(alice.evmAddress);
        
        const txRequest = {
            to: erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit: 100000n,
            maxFeePerGas,
            maxPriorityFeePerGas,
            nonce: nonce,
            chainId: chainId,
            type: 2
        };

        const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
        const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
            alice.evmWallet.signingClient,
            signedTx
        );

        const receipt = (await alice.evmWallet.signingClient.waitForTransaction(txHash))!;
        expect(receipt?.status).to.be.eq(1);
        expect(receipt?.type).to.be.eq(2);
        const baseFeePerGas = await getBaseFeePerBlock(txHash, rpcClient);
        const expectedGasFee = (Number(baseFeePerGas) + maxPriorityFeePerGas) * Number(receipt.gasUsed);
        const senderAfterBalance = await rpcClient.getBalance(alice.evmAddress);
        const senderBalanceDiff = Number(ethers.formatEther(senderPreSeiBalance - senderAfterBalance));
        const userPaidGasFee = Number(ethers.formatEther(receipt.gasPrice * receipt.gasUsed));
        // Verify effective gas price is calculated correctly
        expect(senderBalanceDiff).to.be.eq(userPaidGasFee);
        expect(userPaidGasFee).to.be.eq(Number(ethers.formatEther(expectedGasFee)));
    });

    it('Users can send type 2 txs with max gas fee below base fee and tx fails', async () => {
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('1')]
        );
        
        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const lowMaxFeePerGas = 999999999n; // Below base fee
        
        const txRequest = {
            to: erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit: 100000n,
            maxFeePerGas: lowMaxFeePerGas,
            maxPriorityFeePerGas: 1000000000n,
            nonce: nonce,
            chainId: chainId,
            type: 2
        };

        let failed = false;
        try {
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                alice.evmWallet.signingClient, signedTx
            );
            const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
            expect(receipt?.status).to.not.be.eq(1);
        } catch (err: any) {
            failed = true;
        }
        expect(failed).to.be.true;
    });

    it('Users can send type 2 txs with zero priority fee', async () => {
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('0.1')]
        );
        
        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const maxFeePerGas = 5000000000;
        const txRequest = {
            to: erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit: 100000n,
            maxFeePerGas,
            maxPriorityFeePerGas: 0n,
            nonce: nonce,
            chainId: chainId,
            type: 2
        };

        const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
        const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
            alice.evmWallet.signingClient,
            signedTx
        );

        const receipt = (await alice.evmWallet.signingClient.waitForTransaction(txHash));
        expect(receipt?.status).to.be.eq(1);
        expect(receipt?.type).to.be.eq(2);

        const block = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt.blockNumber), false);
        const baseFee = block.baseFeePerGas;
        expect(Number(receipt.gasPrice)).to.be.eq(Number(baseFee));

    });

    it('Users can send type 2 txs that is above target gas limit and base gas fee reflects the changes', async () => {
        // Create a transaction that will use more gas than the target
        const tx = await gasBurnerContract.burnGasOverMaxLimit(1001, {gasLimit: 8000000, gasPrice: 1100000000});
        const receipt = await tx.wait();
        const nextBlock = Number(receipt!.blockNumber) + 1;
        const prevGasBlockUsed = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), false);
        await waitFor(0.6);
        const baseGasFee = await rpcClient.getBlockByNumber(ethers.toQuantity(nextBlock), false);
        const expectedBaseFee = calcNewBaseFee(Number(prevGasBlockUsed.baseFeePerGas), Number(prevGasBlockUsed.gasUsed));
        expect(Number(baseGasFee.baseFeePerGas)).to.be.eq(expectedBaseFee);
    });

    it('Users can send type 2 txs that is below target gas limit and gas fee reduces', async () => {
        const blockNumber = await rpcClient.getBlockNumber();
        const nextBlock = Number(blockNumber) + 1;
        await waitFor(1);
        const prevGasBlockUsed = await rpcClient.getBlockByNumber(ethers.toQuantity(blockNumber), false);
        await waitFor(0.6);
        const baseGasFee = await rpcClient.getBlockByNumber(ethers.toQuantity(nextBlock), false);
        const expectedBaseFee = calcNewBaseFee(Number(prevGasBlockUsed.baseFeePerGas), Number(prevGasBlockUsed.gasUsed));
        expect(Number(baseGasFee.baseFeePerGas)).to.be.eq(expectedBaseFee);
    });

    let txBlockNumber: number;
    let txHash: string;
    let receipt: TransactionReceipt;
    let maxFeePerGas: number;
    let maxPriorityFeePerGas: number;
    const gasLimit = 100000n;
    it('Gas data is correctly reflected in the eth_getBlockByNumber', async () => {
        // Send a transaction first
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('0.1')]
        );
        
        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        maxFeePerGas = 5000000000;
        maxPriorityFeePerGas = 1000000000;
        const txRequest = {
            to: erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
            nonce: nonce,
            chainId: chainId,
            type: 2
        };

        const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
        txHash = await AtomicTxSender.sendRawTransactionWithProvider(
            alice.evmWallet.signingClient,
            signedTx
        );

        receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
        expect(receipt?.status).to.be.eq(1);
        txBlockNumber = Number(receipt!.blockNumber);
        // Get block by number and verify gas data
        const block = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), true);
        
        expect(block).to.not.be.null;
        expect(block.hash).to.equal(receipt!.blockHash);
        expect(block.number).to.equal(ethers.toQuantity(receipt!.blockNumber));
        expect(block.gasLimit).to.exist;
        expect(block.gasUsed).to.exist;
        expect(block.baseFeePerGas).to.exist;
        
        // Verify gas used is reasonable
        expect(Number(block.gasUsed)).to.be.gt(0);
        expect(Number(block.gasUsed)).to.be.lte(Number(block.gasLimit));
        const tx = block.transactions.find(tx => tx.hash === txHash);
        //validate gas related data from block txs
        const expectedGasPrice = Number(block.baseFeePerGas) + Number(tx.maxPriorityFeePerGas);
        expect(Number(tx.gasPrice)).to.be.eq(expectedGasPrice);
        expect(Number(tx.gas)).to.be.eq(Number(gasLimit));
        expect(Number(tx.maxFeePerGas)).to.be.eq(Number(maxFeePerGas));
        expect(Number(tx.maxPriorityFeePerGas)).to.be.eq(Number(maxPriorityFeePerGas));
        expect(Number(tx.type)).to.be.eq(2);
        expect(Number(tx.nonce)).to.be.eq(Number(nonce));
        expect(Number(tx.value)).to.be.eq(0);
        expect(tx.from.toLowerCase()).to.be.eq(alice.evmAddress.toLowerCase());
        expect(tx.to).to.be.eq(erc20Contract.getAddress());
        expect(tx.input).to.be.eq(data);
        expect(tx.hash).to.be.eq(txHash);
        expect(tx.blockHash).to.be.eq(receipt!.blockHash);
    });

    it('Gas data is correctly reflected in the eth_getBlockByHash', async () => {
        // Send a transaction first
        const blockHash = (await rpcClient.getBlockByNumber(ethers.toQuantity(txBlockNumber))).hash;
        const block = await rpcClient.getBlockByHash(blockHash, true);
        
        expect(block).to.not.be.null;
        expect(block.gasLimit).to.exist;
        expect(block.gasUsed).to.exist;
        expect(block.baseFeePerGas).to.exist;
        
        const tx = block.transactions.find(tx => tx.hash === txHash);
        //validate gas related data from block txs
        const expectedGasPrice = Number(block.baseFeePerGas) + Number(tx.maxPriorityFeePerGas);
        expect(Number(tx.gasPrice)).to.be.eq(expectedGasPrice);
        expect(Number(tx.gas)).to.be.eq(Number(gasLimit));
        expect(Number(tx.maxFeePerGas)).to.be.eq(Number(maxFeePerGas));
        expect(Number(tx.maxPriorityFeePerGas)).to.be.eq(Number(maxPriorityFeePerGas));
    });

    it('Gas data is correctly reflected in eth_getTransactionReceipt', async () => {
        const baseFee = (await rpcClient.getBlockByNumber(ethers.toQuantity(txBlockNumber))).baseFeePerGas;
        const rpcReceipt = await rpcClient.getTransactionReceipt(txHash);
        expect(rpcReceipt).to.not.be.null;
        expect(rpcReceipt.transactionHash).to.equal(txHash);
        // Verify gas used matches
        expect(rpcReceipt.gasUsed).to.equal(ethers.toQuantity(receipt!.gasUsed));
        
        // Verify effective gas price matches
        const effectiveGasPrice = Number(baseFee) + Number(maxPriorityFeePerGas);
        expect(Number(rpcReceipt.effectiveGasPrice)).to.equal(effectiveGasPrice);
    });

    let txByHashResponse;
    it('Gas data is correctly reflected in eth_getTransactionByHash', async () => {
        txByHashResponse = await rpcClient.getTransactionByHash(txHash);
        const baseFee = (await rpcClient.getBlockByNumber(ethers.toQuantity(txBlockNumber))).baseFeePerGas;
        expect(Number(txByHashResponse.maxFeePerGas)).to.be.eq(Number(maxFeePerGas));
        expect(Number(txByHashResponse.maxPriorityFeePerGas)).to.be.eq(Number(maxPriorityFeePerGas));
        expect(Number(txByHashResponse.gas)).to.be.eq(Number(gasLimit));
        expect(Number(txByHashResponse.gasPrice)).to.be.eq(Number(baseFee) + Number(maxPriorityFeePerGas));
    });

    it('Gas data is correctly reflected in eth_getTransactionByBlockNumberAndIndex', async () => {
        // Get transaction by block number and index
        const tx = await rpcClient.getTransactionByBlockNumberAndIndex(
            ethers.toQuantity(receipt!.blockNumber),
            receipt!.transactionIndex
        );
        console.log(receipt);
        console.log(tx);
        expect(tx).to.not.be.null;
        expect(tx.hash).to.equal(txHash);
        expect(tx.gas).to.exist;
        expect(tx.maxFeePerGas).to.exist;
        expect(tx.maxPriorityFeePerGas).to.exist;
        expect(tx.type).to.equal('0x2');
        
        // Verify gas data matches the transaction by hash
        const txByHash = await rpcClient.getTransactionByHash(txHash);
        expect(tx.gas).to.equal(txByHash.gas);
        expect(tx.maxFeePerGas).to.equal(txByHash.maxFeePerGas);
        expect(tx.maxPriorityFeePerGas).to.equal(txByHash.maxPriorityFeePerGas);
    });
});

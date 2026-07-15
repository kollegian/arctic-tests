import {ethers, TransactionReceipt} from "ethers";
import {SeiUser, UserFactory} from "../../shared/User";
import {Erc20Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import {EvmRpcClient} from "../../shared/RpcClient";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {expect} from "chai";
import testConfig from "../../config/testConfig.json";
import {RealGasBurner} from "../../typechain-types";
import heavyGasAbi from "../../artifacts/contracts/GasBurner.sol/RealGasBurner.json";
import {calcNewBaseFee, waitFor, queryEip1559Params, Eip1559Params} from "../../shared/utils/helpers";

describe('Gas tests', function () {
    this.timeout(10 * 60 * 1000);
    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;

    let erc20Contract: Erc20Token;
    let gasBurnerContract: RealGasBurner;
    let rpcClient: EvmRpcClient;
    let chainId: bigint;
    let eip1559Params: Eip1559Params;

    before('Initializes client', async () => {
        admin = await UserFactory.createAdminUser();
        [alice, bob] = await UserFactory.createSeiUsers(admin, 2);
        const contractFactory = new ethers.ContractFactory(heavyGasAbi.abi, heavyGasAbi.bytecode, alice.evmWallet.wallet);
        const deploymentTx = await contractFactory.deploy();
        gasBurnerContract = await deploymentTx.waitForDeployment() as unknown as RealGasBurner;
        rpcClient = new EvmRpcClient(testConfig.evmRpcEndpoint, admin.evmWallet.signingClient);
        chainId = (await alice.evmWallet.signingClient.getNetwork()).chainId;

        // Deploy a fresh ERC20 (self-contained) instead of reading the address the
        // tokens suite may or may not have left behind in contractAddresses.json.
        const deployer = new TokenDeployer(admin);
        erc20Contract = await deployer.deployErc20();
        eip1559Params = await queryEip1559Params();
    });

    it('Users can send legacy txs and the gas fee charges specified amount', async () => {
        const mintTx = await erc20Contract.mint(alice.evmAddress, ethers.parseEther('100').toString());
        await mintTx.wait();
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('0.1')]
        );
        const senderPreSeiBalance = await rpcClient.getBalance(alice.evmAddress);
        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const feeData = await alice.evmWallet.signingClient.getFeeData();
        const gasPrice = feeData.gasPrice!;
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
        const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
        expect(receipt?.status).to.be.eq(1);
        expect(receipt?.type).to.be.eq(0);
        expect(receipt?.gasPrice).to.not.be.undefined;
        expect(receipt?.gasUsed).to.not.be.undefined;
        expect(Number(receipt!.gasUsed)).to.be.lt(Number(gasLimit));
        expect(receipt!.gasPrice).to.be.eq(gasPrice);

        const senderAfterBalance = await rpcClient.getBalance(alice.evmAddress);
        const senderBalanceDiff = ethers.formatEther(senderPreSeiBalance - senderAfterBalance);
        const userPaidGasFee = ethers.formatEther(receipt!.gasPrice * receipt!.gasUsed);
        expect(senderBalanceDiff).to.be.eq(userPaidGasFee);
    });

    it('Users can send legacy txs with insufficient gas limit and tx fails', async () => {
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('1')]
        );

        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const feeData = await alice.evmWallet.signingClient.getFeeData();
        const insufficientGasLimit = 1000n;

        const txRequest = {
            to: erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit: insufficientGasLimit,
            gasPrice: feeData.gasPrice!,
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
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('1')]
        );
        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const latestBlock = await rpcClient.getBlockByNumber('latest', false);
        const currentBaseFee = BigInt(latestBlock.baseFeePerGas);
        const lowGasPrice = currentBaseFee - 1n;

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
        const feeData = await alice.evmWallet.signingClient.getFeeData();
        const maxFeePerGas = feeData.maxFeePerGas!;
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas!;
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
        expect(receipt.status).to.be.eq(1);
        expect(receipt.type).to.be.eq(2);
        const block = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt.blockNumber), false);
        const baseFee = BigInt(block.baseFeePerGas);
        const effectiveTip = maxPriorityFeePerGas < maxFeePerGas - baseFee ? maxPriorityFeePerGas : maxFeePerGas - baseFee;
        const expectedEffectiveGasPrice = baseFee + effectiveTip;
        expect(receipt.gasPrice).to.be.eq(expectedEffectiveGasPrice);

        const expectedGasFee = expectedEffectiveGasPrice * receipt.gasUsed;
        const senderAfterBalance = await rpcClient.getBalance(alice.evmAddress);
        const senderBalanceDiff = ethers.formatEther(senderPreSeiBalance - senderAfterBalance);
        const userPaidGasFee = ethers.formatEther(expectedGasFee);
        expect(senderBalanceDiff).to.be.eq(userPaidGasFee);
    });

    it('Users can send type 2 txs with max gas fee below base fee and tx fails', async () => {
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('1')]
        );

        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const latestBlock = await rpcClient.getBlockByNumber('latest', false);
        const currentBaseFee = BigInt(latestBlock.baseFeePerGas);
        const lowMaxFeePerGas = currentBaseFee - 1n;

        const txRequest = {
            to: erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit: 100000n,
            maxFeePerGas: lowMaxFeePerGas,
            maxPriorityFeePerGas: 1n,
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
        const feeData = await alice.evmWallet.signingClient.getFeeData();
        const maxFeePerGas = feeData.maxFeePerGas!;
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

        const receipt = (await alice.evmWallet.signingClient.waitForTransaction(txHash))!;
        expect(receipt.status).to.be.eq(1);
        expect(receipt.type).to.be.eq(2);

        const block = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt.blockNumber), false);
        const baseFee = BigInt(block.baseFeePerGas);
        expect(receipt.gasPrice).to.be.eq(baseFee);
    });

    it('Users can send type 2 txs with high gas limit and base gas fee matches expectation', async () => {
        const feeData = await alice.evmWallet.signingClient.getFeeData();
        const tx = await gasBurnerContract.burnGasIterations(30, 95, {gasLimit: 8000000, gasPrice: feeData.gasPrice!});
        const receipt = await tx.wait();
        const nextBlock = Number(receipt!.blockNumber) + 1;
        const prevBlockData = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), false);
        await waitFor(0.6);
        const nextBlockData = await rpcClient.getBlockByNumber(ethers.toQuantity(nextBlock), false);
        const expectedBaseFee = calcNewBaseFee(Number(prevBlockData.baseFeePerGas), Number(prevBlockData.gasUsed), eip1559Params);
        expect(Number(nextBlockData.baseFeePerGas)).to.be.eq(expectedBaseFee);
        expect(Number(nextBlockData.baseFeePerGas)).to.be.gte(eip1559Params.minFeePerGas);
        expect(Number(nextBlockData.baseFeePerGas)).to.be.lte(eip1559Params.maxFeePerGas);
    });

    it('Users can send type 2 txs that is below target gas limit and gas fee reduces', async () => {
        const blockNumber = await rpcClient.getBlockNumber();
        const nextBlock = Number(blockNumber) + 1;
        await waitFor(1);
        const prevBlockData = await rpcClient.getBlockByNumber(ethers.toQuantity(blockNumber), false);
        const prevBaseFee = Number(prevBlockData.baseFeePerGas);
        await waitFor(0.6);
        const nextBlockData = await rpcClient.getBlockByNumber(ethers.toQuantity(nextBlock), false);
        const actualNextBaseFee = Number(nextBlockData.baseFeePerGas);
        const expectedBaseFee = calcNewBaseFee(prevBaseFee, Number(prevBlockData.gasUsed), eip1559Params);
        expect(actualNextBaseFee).to.be.eq(expectedBaseFee);
        expect(actualNextBaseFee).to.be.lte(prevBaseFee);
        expect(actualNextBaseFee).to.be.gte(eip1559Params.minFeePerGas);
    });

    let txBlockNumber: number;
    let txHash: string;
    let receipt: TransactionReceipt;
    let sentMaxFeePerGas: bigint;
    let sentMaxPriorityFeePerGas: bigint;
    const gasLimit = 100000n;
    it('Gas data is correctly reflected in the eth_getBlockByNumber', async () => {
        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer',
            [bob.evmAddress, ethers.parseEther('0.1')]
        );

        const nonce = await alice.evmWallet.wallet.getNonce('latest');
        const feeData = await alice.evmWallet.signingClient.getFeeData();
        sentMaxFeePerGas = feeData.maxFeePerGas!;
        sentMaxPriorityFeePerGas = feeData.maxPriorityFeePerGas!;
        const txRequest = {
            to: erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit,
            maxFeePerGas: sentMaxFeePerGas,
            maxPriorityFeePerGas: sentMaxPriorityFeePerGas,
            nonce: nonce,
            chainId: chainId,
            type: 2
        };

        const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
        txHash = await AtomicTxSender.sendRawTransactionWithProvider(
            alice.evmWallet.signingClient,
            signedTx
        );

        receipt = (await alice.evmWallet.signingClient.waitForTransaction(txHash))!;
        expect(receipt.status).to.be.eq(1);
        txBlockNumber = receipt.blockNumber;
        const block = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt.blockNumber), true);

        expect(block).to.not.be.null;
        expect(block.hash).to.equal(receipt.blockHash);
        expect(block.number).to.equal(ethers.toQuantity(receipt.blockNumber));
        expect(block.gasLimit).to.exist;
        expect(block.gasUsed).to.exist;
        expect(block.baseFeePerGas).to.exist;

        expect(Number(block.gasUsed)).to.be.gt(0);
        expect(Number(block.gasUsed)).to.be.lte(Number(block.gasLimit));
        const tx = block.transactions.find((tx: any) => tx.hash === txHash);
        const baseFee = BigInt(block.baseFeePerGas);
        const tip = sentMaxPriorityFeePerGas < sentMaxFeePerGas - baseFee ? sentMaxPriorityFeePerGas : sentMaxFeePerGas - baseFee;
        const expectedGasPrice = baseFee + tip;
        expect(BigInt(tx.gasPrice)).to.be.eq(expectedGasPrice);
        expect(Number(tx.gas)).to.be.eq(Number(gasLimit));
        expect(BigInt(tx.maxFeePerGas)).to.be.eq(sentMaxFeePerGas);
        expect(BigInt(tx.maxPriorityFeePerGas)).to.be.eq(sentMaxPriorityFeePerGas);
        expect(Number(tx.type)).to.be.eq(2);
        expect(Number(tx.nonce)).to.be.eq(Number(nonce));
        expect(Number(tx.value)).to.be.eq(0);
        expect(tx.from.toLowerCase()).to.be.eq(alice.evmAddress.toLowerCase());
        expect(tx.to.toLowerCase()).to.be.eq((erc20Contract.getAddress() as string).toLowerCase());
        expect(tx.input).to.be.eq(data);
        expect(tx.hash).to.be.eq(txHash);
        expect(tx.blockHash).to.be.eq(receipt.blockHash);
    });

    it('Gas data is correctly reflected in the eth_getBlockByHash', async () => {
        const blockHash = (await rpcClient.getBlockByNumber(ethers.toQuantity(txBlockNumber))).hash;
        const block = await rpcClient.getBlockByHash(blockHash, true);

        expect(block).to.not.be.null;
        expect(block.gasLimit).to.exist;
        expect(block.gasUsed).to.exist;
        expect(block.baseFeePerGas).to.exist;

        const tx = block.transactions.find((tx: any) => tx.hash === txHash);
        const baseFee = BigInt(block.baseFeePerGas);
        const tip = sentMaxPriorityFeePerGas < sentMaxFeePerGas - baseFee ? sentMaxPriorityFeePerGas : sentMaxFeePerGas - baseFee;
        const expectedGasPrice = baseFee + tip;
        expect(BigInt(tx.gasPrice)).to.be.eq(expectedGasPrice);
        expect(Number(tx.gas)).to.be.eq(Number(gasLimit));
        expect(BigInt(tx.maxFeePerGas)).to.be.eq(sentMaxFeePerGas);
        expect(BigInt(tx.maxPriorityFeePerGas)).to.be.eq(sentMaxPriorityFeePerGas);
    });

    it('Gas data is correctly reflected in eth_getTransactionReceipt', async () => {
        const block = await rpcClient.getBlockByNumber(ethers.toQuantity(txBlockNumber));
        const baseFee = BigInt(block.baseFeePerGas);
        const rpcReceipt = await rpcClient.getTransactionReceipt(txHash);
        expect(rpcReceipt).to.not.be.null;
        expect(rpcReceipt.transactionHash).to.equal(txHash);
        expect(rpcReceipt.gasUsed).to.equal(ethers.toQuantity(receipt.gasUsed));

        const tip = sentMaxPriorityFeePerGas < sentMaxFeePerGas - baseFee ? sentMaxPriorityFeePerGas : sentMaxFeePerGas - baseFee;
        const expectedEffectiveGasPrice = baseFee + tip;
        expect(BigInt(rpcReceipt.effectiveGasPrice)).to.equal(expectedEffectiveGasPrice);
    });

    let txByHashResponse: any;
    it('Gas data is correctly reflected in eth_getTransactionByHash', async () => {
        txByHashResponse = await rpcClient.getTransactionByHash(txHash);
        const block = await rpcClient.getBlockByNumber(ethers.toQuantity(txBlockNumber));
        const baseFee = BigInt(block.baseFeePerGas);
        expect(BigInt(txByHashResponse.maxFeePerGas)).to.be.eq(sentMaxFeePerGas);
        expect(BigInt(txByHashResponse.maxPriorityFeePerGas)).to.be.eq(sentMaxPriorityFeePerGas);
        expect(Number(txByHashResponse.gas)).to.be.eq(Number(gasLimit));
        const tip = sentMaxPriorityFeePerGas < sentMaxFeePerGas - baseFee ? sentMaxPriorityFeePerGas : sentMaxFeePerGas - baseFee;
        expect(BigInt(txByHashResponse.gasPrice)).to.be.eq(baseFee + tip);
    });

    it('Gas data is correctly reflected in eth_getTransactionByBlockNumberAndIndex', async () => {
        // Get transaction by block number and index
        const tx = await rpcClient.getTransactionByBlockNumberAndIndex(
            ethers.toQuantity(receipt!.blockNumber),
            receipt!.index
        );

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

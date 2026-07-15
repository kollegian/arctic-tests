import {SeiUser, UserFactory} from "../../shared/User";
import {Cw721Token, Erc721Token} from "../../shared/Token";
import fs from "fs";
import TransactionBuilder from "../../shared/TransactionBuilder";
import {waitFor} from "../../shared/utils/helpers";
import {expect} from "chai";
import {EvmRpcClient} from "../../shared/RpcClient";
import {ContractTransactionReceipt, ethers, TransactionReceipt} from "ethers";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {erc20} from "../../typechain-types/@openzeppelin/contracts/token";
import {isWasmEnabled} from "../../shared/utils/testFlags";

// The whole suite depends on a freshly deployed CW721 contract, which is
// impossible on nodes where wasm is disabled (e.g. testnet).
(isWasmEnabled() ? describe : describe.skip)('Cw721 Tests', function () {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let cw721Contract: Cw721Token;
    let erc721Contract: Erc721Token;
    let evmRpcClient: EvmRpcClient;
    const nftStartId = 7500;

    before('Initialize', async () => {
        admin = await UserFactory.createAdminUser();
        const cw721Address = JSON.parse(fs.readFileSync('./tests/tokens/contractAddresses.json', 'utf8')).cw721Address;
        cw721Contract = new Cw721Token(admin, cw721Address);
        users = await UserFactory.createSeiUsers(admin, 10, true);
        evmRpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
    });

    let mintTxHeight: number;
    let nftId: string;
    it('Admin can mint tokens before pointer deployment', async () => {
        nftId = (nftStartId + 4).toString();
        const mintTx = await cw721Contract.mintTx(nftId, admin.seiAddress);
        mintTxHeight = mintTx.height;
        const nftOwner = await cw721Contract.ownerOf(nftId);
        expect(nftOwner).to.be.equal(admin.seiAddress);
    });

    it.skip('Before pointer deployment, synthetic events are not recorded with sei_getBlockByNumber', async () => {
        const rpcResult = await evmRpcClient.sei_getBlockByNumber(ethers.toQuantity(mintTxHeight), true);
        const tx = rpcResult.transactions.find(tx => tx.from.toLowerCase() === admin.evmAddress.toLowerCase());
        expect(tx).to.be.undefined;
    });

    it.skip('Before pointer deployment, synthetic events are not thrown with sei_getBlockByHash', async () => {
        const hash = (await evmRpcClient.getBlockByNumber(ethers.toQuantity(mintTxHeight), true)).hash;
        const rpcResult = await evmRpcClient.sei_getBlockByHash(hash, true);
        const tx = rpcResult.transactions.find(tx => tx.from.toLowerCase() === admin.evmAddress.toLowerCase());
        expect(tx).to.be.undefined;
    });

    it.skip('Before pointer deployment, synthetic events are not thrown with sei_getLogs', async () => {
        const logs = {
            fromBlock: ethers.toQuantity(mintTxHeight.toString()),
            toBlock: ethers.toQuantity(mintTxHeight.toString()),
        }
        const results = await evmRpcClient.sei_getLogs(logs);
        console.log(results);
    });

    it.skip('Before pointer deployment, synthetic events are not thrown with eth_getLogs', async () => {
        const logs = {
            fromBlock: ethers.toQuantity(mintTxHeight.toString()),
            toBlock: ethers.toQuantity(mintTxHeight.toString()),
        }
        const results = await evmRpcClient.getLogs(logs);
        expect(results.length).to.equal(0);
    });

    it('Before pointer deployment, admin can approve newly minted token for Alice', async () => {
        await cw721Contract.approve(users[0].seiAddress, nftId);
        const approved = await cw721Contract.getApproved(nftId);
        expect(approved).to.equal(users[0].seiAddress);
    });

    it('Bob cant transfer newly minted token to someone else without approval', async () => {
        try {
            cw721Contract.setSigner(users[4]);
            const tx = await cw721Contract.safeTransferFrom(admin.seiAddress, users[5].seiAddress, nftId);
            throw new Error('Should have thrown error');
        } catch (e: any) {
            expect(e.message).to.contain('Error when broadcasting tx');
        }
    });

    it('Alice can transfer newly minted token to bob after getting approval', async () => {
        cw721Contract.setSigner(users[0]);
        await cw721Contract.safeTransferFrom(admin.seiAddress, users[1].seiAddress, nftId);
        expect(await cw721Contract.ownerOf(nftId)).to.equal(users[1].seiAddress);
    });

    it('After transferring the token, Alice cant move token from Bob', async () => {
        cw721Contract.setSigner(users[0]);
        try {
            await cw721Contract.safeTransferFrom(users[1].seiAddress, users[0].seiAddress, nftId);
            expect.fail('Should have thrown error');
        } catch (e: any) {
            expect(e.message).to.contain('Error when broadcasting tx');
        }
    });

    it('Admin mints another nft and approves it for Bob', async () => {
        cw721Contract.setSigner(admin);
        const nftId2 = (nftStartId + 15).toString();
        const mintTx = await cw721Contract.mintTx(nftId2, admin.seiAddress);
        const nftOwner = await cw721Contract.ownerOf(nftId2);
        expect(nftOwner).to.be.equal(admin.seiAddress);
        await cw721Contract.approve(users[1].seiAddress, nftId2);
        const approved = await cw721Contract.getApproved(nftId2);
        expect(approved).to.equal(users[1].seiAddress);
    });

    it('Bob cant transfer tokens after approval revocation', async () => {
        await cw721Contract.revokeApproval(users[1].seiAddress, (nftStartId + 15).toString());
        const approved = await cw721Contract.getApproved((nftStartId + 15).toString());
        console.log(approved);
        try {
            cw721Contract.setSigner(users[2]);
            await cw721Contract.safeTransferFrom(admin.seiAddress, users[1].seiAddress, (nftStartId + 15).toString());
            expect.fail('Should have thrown error');
        } catch (e: any) {
            expect(e.message).to.contain('Error when broadcasting tx');
        }
    });

    it('OwnerOf function returns correct token owner', async () => {
        const token1Owner = await cw721Contract.ownerOf('0');
        expect(token1Owner).to.equal(users[0].seiAddress);

        const token2Owner = await cw721Contract.ownerOf('1');
        expect(token2Owner).to.equal(users[1].seiAddress);
    });

    it('TokenUri function returns correct URI', async () => {
        const tokenUri = await cw721Contract.tokenUri('1');
        expect(tokenUri).to.contain('https://example.com/token1.json');
    });

    let nftId3: string;
    it('Admin mints tokens and approves them for Alice', async () => {
        cw721Contract.setSigner(admin);
        nftId3 = (nftStartId + 16).toString();
        const mintTx = await cw721Contract.mintTx(nftId3, admin.seiAddress);
        await cw721Contract.approve(users[0].seiAddress, nftId3);
    });

    it('Admin can register a pointer for cw721 contract', async () => {
        const pointerAddress = await cw721Contract.deployPointer(admin.evmRpcEndpoint);
        erc721Contract = new Erc721Token(admin, pointerAddress);
    });

    it('Ownerships are migrated on to evm runtime', async () =>{
        const ownerOf = await erc721Contract.ownerOf('1');
        expect(ownerOf).to.equal(users[1].evmAddress);

        const ownerOf2 = await erc721Contract.ownerOf('2');
        expect(ownerOf2).to.equal(users[2].evmAddress);
    });

    it('Approvals are migrated on to evm runtime', async () =>{
        const approval = await erc721Contract.getApproved(nftId3);
        expect(approval).to.equal(users[0].evmAddress);
    });

    it('Bob can transfer nfts approved on cosmos runtime, to evm runtime', async () =>{
        const tx = await erc721Contract.contract.connect(users[0].evmWallet.wallet)
            .safeTransferFrom(admin.evmAddress, users[3].evmAddress, nftId3);
        await tx.wait();
        const ownerOf = await erc721Contract.ownerOf(nftId3);
        expect(ownerOf).to.equal(users[3].evmAddress);

        const ownerOnCosmos = await cw721Contract.ownerOf(nftId3);
        expect(ownerOnCosmos).to.equal(users[3].seiAddress);

    });

    it('Bob can approve nft on evm runtime to Alice', async () =>{
        const tx = await erc721Contract.contract.connect(users[3].evmWallet.wallet)
            .approve(users[0].evmAddress, nftId3);
        await tx.wait();
        const approved = await erc721Contract.getApproved(nftId3);
        expect(approved).to.equal(users[0].evmAddress);
    });

    it('Alice can transfer on cosmos runtime for evm approved token', async () =>{
        cw721Contract.setSigner(users[0]);
        const tx = await cw721Contract.safeTransferFrom(users[3].seiAddress, users[1].seiAddress, nftId3);
        const ownerOf = await erc721Contract.ownerOf(nftId3);
        expect(ownerOf).to.equal(users[1].evmAddress);
    });

    let transferReceipt: ContractTransactionReceipt;
    let gasPaid: string;
    let txReceipt: TransactionReceipt;
    let receiptLogs: string;
    let liveFeeData: ethers.FeeData;
    let signedTxFees: { maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null };

    let multipleTxBlock: number;
    it.skip('In a block with multiple transactions from cosmos and evm runtime', async () =>{
        const txBuilder = new TransactionBuilder(users);
        txBuilder.setCw721Token(cw721Contract);
        txBuilder.setErc721Token(erc721Contract);
        multipleTxBlock = await txBuilder.formToken721Txs();
    });

    it('Eth_getTransactionReceipt returns correct information on erc721 transfer from pointer', async () => {
        cw721Contract.setSigner(admin);
        await cw721Contract.mint('5555', users[0].seiAddress);
        liveFeeData = await users[0].evmWallet.signingClient.getFeeData();
        const encodedTx = erc721Contract.contract.interface.encodeFunctionData('transferFrom', [users[0].evmAddress, users[1].evmAddress, '5555']);
        const signedTx = await AtomicTxSender
            .signEvmTransaction(users[0], erc721Contract.getAddress(), encodedTx)
        const parsedSigned = ethers.Transaction.from(signedTx);
        signedTxFees = {
            maxFeePerGas: parsedSigned.maxFeePerGas,
            maxPriorityFeePerGas: parsedSigned.maxPriorityFeePerGas,
        };
        const hash = await evmRpcClient.sendRawTransaction(signedTx);
        await waitFor(1);
        const txReceipt = await evmRpcClient.getTransactionReceipt(hash);
        transferReceipt = (await evmRpcClient.getBlockByNumber(txReceipt.blockNumber, true))
            .transactions.find((tx: any) => tx.hash === hash);
        receiptLogs = JSON.stringify(txReceipt.logs[0]);

        // validate the fields
        expect(txReceipt.blockHash).to.equal(transferReceipt.blockHash);
        expect(txReceipt.blockNumber).to.equal(transferReceipt.blockNumber);
        expect(txReceipt.transactionHash).to.equal(transferReceipt.hash);
        expect(txReceipt.transactionIndex).to.equal(ethers.toQuantity(transferReceipt.transactionIndex));
        expect(txReceipt.from.toLowerCase()).to.equal(users[0].evmAddress.toLowerCase());
        expect(txReceipt.to.toLowerCase()).to.equal((erc721Contract.getAddress() as string).toLowerCase());
        // expect(txReceipt.cumulativeGasUsed).to.equal(ethers.toQuantity(0));
        expect(txReceipt.logs.length).to.equal(1);
        expect(txReceipt.logs[0].address.toLowerCase()).to.equal((erc721Contract.getAddress() as string).toLowerCase());
        const feePaidPerReceipt = Number(txReceipt.gasUsed) * Number(txReceipt.effectiveGasPrice);
        const baseFee = (await evmRpcClient.getBlockByNumber(txReceipt.blockNumber, false)).baseFeePerGas;

        // Decode using contract interface
        const decodedEvent = erc721Contract.contract.interface.parseLog({
            topics: txReceipt.logs[0].topics,
            data: txReceipt.logs[0].data
        });
        expect(decodedEvent?.name).to.equal('Transfer');
        expect(decodedEvent?.args.from.toLowerCase()).to.equal(users[0].evmAddress.toLowerCase());
        expect(decodedEvent?.args.to.toLowerCase()).to.equal(users[1].evmAddress.toLowerCase());
        expect(decodedEvent?.args.tokenId.toString()).to.equal('5555');

        expect(txReceipt.logs[0].blockNumber).to.equal(txReceipt.blockNumber);
        expect(txReceipt.logs[0].blockHash).to.equal(txReceipt.blockHash);
        expect(txReceipt.logs[0].transactionHash).to.equal(txReceipt.transactionHash);
        expect(txReceipt.logs[0].transactionIndex).to.equal(txReceipt.transactionIndex);
    });

    it('Eth_getTransactionByHash returns correct information on erc721 transfer from pointer', async () => {
        const txHashResponse = await evmRpcClient.getTransactionByHash(transferReceipt.hash);
        expect(txHashResponse.blockHash).to.equal(transferReceipt.blockHash);
        expect(txHashResponse.blockNumber).to.equal(transferReceipt.blockNumber);
        expect(txHashResponse.hash).to.equal(transferReceipt.hash);
        expect(txHashResponse.from.toLowerCase()).to.equal(users[0].evmAddress.toLowerCase());
        expect(txHashResponse.to).to.equal((erc721Contract.getAddress() as string).toLowerCase());
        expect(txHashResponse.maxPriorityFeePerGas).to.equal(ethers.toQuantity(signedTxFees.maxPriorityFeePerGas!));
        expect(txHashResponse.maxFeePerGas).to.equal(ethers.toQuantity(signedTxFees.maxFeePerGas!));

        const baseFeeOnBlock = (await evmRpcClient.getBlockByNumber(transferReceipt.blockNumber, false)).baseFeePerGas;
        expect(Number(txHashResponse.gasPrice)).to.equal(Number(baseFeeOnBlock) + Number(txHashResponse.maxPriorityFeePerGas));
    });

    it('Eth_getLogs returns correct information on erc721 transfer from pointer', async () => {
        const logs = {
            fromBlock: ethers.toQuantity(transferReceipt.blockNumber),
            toBlock: ethers.toQuantity((transferReceipt.blockNumber)),
            address: erc721Contract.getAddress() as string,
        }
        const rpcResult = await evmRpcClient.getLogs(logs);
        expect(JSON.stringify(rpcResult[0])).to.equal(receiptLogs);
    });

    it('Multiple events thrown are reflected on evm runtime', async () => {
        await cw721Contract.mintMultiple(['6666', '77777'], [users[0].seiAddress, users[1].seiAddress]);
        const ownerOf = await erc721Contract.ownerOf('6666');
        expect(ownerOf).to.equal(users[0].evmAddress);
        const ownerOf2 = await erc721Contract.ownerOf('77777');
        expect(ownerOf2).to.equal(users[1].evmAddress);
    });
});

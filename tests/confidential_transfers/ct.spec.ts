import {SeiUser, UserFactory} from "../../shared/User";
import * as TestConfig from "../../config/testConfig.json";
import {
    applyPendingBalanceEthers, closeAccountEthers, confidentialTransferEthers,
    decryptAccountEthers,
    decryptAvailableBalanceEthers, decryptPendingBalancesEthers,
    getDenomToSignEthers,
    initializeAccountEthers,
    queryAccountEthers, withdrawFromPrivateBalanceEthers,
} from "@sei-js/confidential-transfers";
import {expect} from "chai";
import {CtAccount} from "@sei-js/cosmos/dist/types/types/confidentialtransfers";
import {ethers} from "ethers";
import {createCtUsers, waitFor} from "../../utils/helpers";
import {EvmRpcClient} from "../../shared/RpcClient";
import {TokenDeployer} from "../../shared/Deployer";
import {TestERC20} from "../../typechain-types";

describe('Confidential Transfers', function ()  {
    this.timeout(10 * 60 * 1000);
    let admin: SeiUser;
    let users: SeiUser[];
    let aliceDenomHash: string;
    let bobDenomHash: string;
    let aliceSignedDenom: string;
    let alice: SeiUser, ferdie: SeiUser;
    let bob: SeiUser;
    let bobSignedDenom: string;
    let rpcClient: EvmRpcClient;

    before('Initializes clients and users', async () => {
        admin = await UserFactory.createAdminUser(TestConfig);
        await UserFactory.fundAdminOnSei();
        ({alice, bob} = await createCtUsers(admin));
        console.log(alice.evmWallet.wallet.mnemonic);

        ferdie = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
        await ferdie.initialize('', 'ferdie', true);

        await UserFactory.fundAddressOnSei(ferdie.seiAddress);
        await waitFor(1);
        console.log(alice.seiAddress);
        console.log(bob.seiAddress);

        aliceDenomHash = getDenomToSignEthers('usei');
        aliceSignedDenom = await alice.evmWallet.wallet.signMessage(aliceDenomHash);
        bobDenomHash = getDenomToSignEthers('usei');
        rpcClient = new EvmRpcClient(admin.evmRpcEndpoint);
    });

    it('Before initialization users cant query accounts', async () =>{
        const account = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet);
        expect(account).to.be.eq(null);
    });

    it('Alice cant initialize admin account', async () =>{
        try{
            const enabledAccount = await initializeAccountEthers(aliceSignedDenom, alice.evmAddress, 'usei', bob.evmWallet.wallet);
            throw new Error('Should not be able to initialize admin account');
        } catch(e: any){
            expect(e.message).to.contain('execution reverted');
        }

    })

    it('Users can enable confidential transfers on their accounts for sei', async () =>{
        await initializeAccountEthers(aliceSignedDenom, alice.evmAddress, 'usei', alice.evmWallet.wallet);
        const account = await queryAccountEthers(alice.evmAddress, 'usei', bob.evmWallet.wallet) as CtAccount;
        expect(account).to.be.an("object");
        expect(account).to.have.all.keys(
            "public_key",
            "pending_balance_lo",
            "pending_balance_hi",
            "pending_balance_credit_counter",
            "available_balance",
            "decryptable_available_balance"
        );

        expect(account.public_key).to.be.instanceOf(Uint8Array);

        ["pending_balance_lo", "pending_balance_hi", "available_balance"].forEach((field) => {
            const part = (account as any)[field] as { c: Uint8Array; d: Uint8Array };
            expect(part).to.be.an("object").that.has.all.keys("c", "d");
            expect(part.c).to.be.instanceOf(Uint8Array);
            expect(part.d).to.be.instanceOf(Uint8Array);
        });

        expect(account.pending_balance_credit_counter).to.be.a("number");
        expect(account.decryptable_available_balance).to.be.a("string");
    });

    it('Users can decrypt balance', async () =>{
        const account = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;
        const decryptedBalance = await decryptAvailableBalanceEthers(aliceSignedDenom, account);
        expect(decryptedBalance.toString()).to.be.eq('0');
    });

    it.skip('Wrong private keys dont decrypt available balance', async () =>{
        signedDenom = await bob.evmWallet.wallet.signMessage(denomHash);

        const account = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;
        const decryptedBalance = await decryptAvailableBalanceEthers(signedDenom, account);
        console.log(decryptedBalance);
    });

    it.skip('Wrong private keys dont decrypt pending balance', async () =>{
        const signedDenomBob = await bob.evmWallet.wallet.signMessage(bobDenomHash);
        const account = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;

        const allDecryptedField = await decryptAccountEthers(signedDenomBob, account, true);
        console.log(allDecryptedField);
    });

    it('Users can deposit tokens once initialized', async () =>{
        const tx = await depositToPrivateBalanceEthers('usei', 1000000, alice.evmWallet.wallet);
        const account = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;

        const allDecryptedField = await decryptAccountEthers(aliceSignedDenom, account, true);
        expect(allDecryptedField).to.be.an("object");
        expect(allDecryptedField).to.have.all.keys(
            "publicKey",
            "pendingBalanceLo",
            "pendingBalanceHi",
            "totalPendingBalance",
            "pendingBalanceCreditCounter",
            "availableBalance",
            "decryptableAvailableBalance"
        );

        // individual fields
        expect(allDecryptedField.publicKey).to.be.a("string");
        expect(allDecryptedField.pendingBalanceLo).to.be.a("bigint");
        expect(allDecryptedField.pendingBalanceHi).to.be.a("bigint");
        expect(allDecryptedField.totalPendingBalance).to.be.a("bigint").eq(1000000n);
        // expect(allDecryptedField.decryptableAvailableBalance).to.be.a("bigint");
        expect(allDecryptedField.pendingBalanceCreditCounter).to.be.a("number");
        expect(allDecryptedField.availableBalance).to.be.a("string");
        const publicKey = (await alice.seiWallet.wallet.getAccounts())[0];
    });

    it('Uninitialized cant deposit tokens', async () =>{
        try{
            await depositToPrivateBalanceEthers('usei', 1000000, bob.evmWallet.wallet);
            throw new Error('Should not be able to deposit tokens');
        } catch(e: any){
            expect(e.message).to.contain('execution reverted');
        }
    });

    it('Bob can also enable ct transfers', async () =>{
        bobSignedDenom = await bob.evmWallet.wallet.signMessage(bobDenomHash);
        try {
            const account = await queryAccountEthers(bob.evmAddress, 'usei', bob.evmWallet.wallet) as CtAccount;
            console.log('First query returned');
        } catch(e: any) {
            console.log('First message ', e.message);
        }
        try {
            await initializeAccountEthers(bobSignedDenom, bob.evmAddress, 'usei', bob.evmWallet.wallet);
            const account = await queryAccountEthers(bob.evmAddress, 'usei', bob.evmWallet.wallet) as CtAccount;
        } catch (e: any){
            expect(e.message).to.contain('execution reverted');
        }
    });

    it('Alice can apply pending balances', async () =>{
        const aliceAccountPre = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;
        const alicePreBalance = await decryptAvailableBalanceEthers(aliceSignedDenom, aliceAccountPre);
        console.log(alicePreBalance);
        await applyPendingBalanceEthers(alice.evmAddress, 'usei', aliceSignedDenom, alice.evmWallet.wallet);
        const aliceAccountAfter = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;
        const aliceAfterBalance = await decryptAvailableBalanceEthers(aliceSignedDenom, aliceAccountAfter);
        console.log(aliceAfterBalance);
    });

    it('Alice can send tokens to initialized Bob', async () => {
        console.log('Started transferring ethers');
        const aliceAccount = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;
        const priorBalanceAlice = await decryptAccountEthers(aliceSignedDenom, aliceAccount, true);
        console.log(priorBalanceAlice);
        const tx = await confidentialTransferEthers(alice.evmAddress, bob.evmAddress, 'usei', 500000, aliceSignedDenom, alice.evmWallet.wallet);
        console.log(tx);
        const afterBalanceAlice = await decryptAccountEthers(aliceSignedDenom, aliceAccount, true);
        console.log(afterBalanceAlice);
        console.log('Finished transferring ethers');
        console.log('Trying to decrypt the balance');
        const bobAccount = await queryAccountEthers(bob.evmAddress, 'usei', bob.evmWallet.wallet) as CtAccount;
        expect(bobAccount.pending_balance_credit_counter).to.be.eq(1);
        const decrypted = await decryptAccountEthers(bobSignedDenom, bobAccount, true);
        console.log(decrypted);
        console.log('----');
        const decryptedPending = await decryptPendingBalancesEthers(bobSignedDenom, bobAccount);
        console.log(decryptedPending);
    });

    it.skip('Alice deposits thousands of tokens', async () =>{
        await initializeAccountEthers(aliceSignedDenom, alice.evmAddress, 'usei', alice.evmWallet.wallet);
        console.log('Initialized alice');
        await UserFactory.fundAddressOnSei(alice.seiAddress, 'usei', '15000000000');
        await depositToPrivateBalanceEthers('usei', 15000000000, alice.evmWallet.wallet);

        const aliceAccount = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;
        const timeBeforeDecrypt = new Date().getTime();
        const decryptedPendingBalance = await decryptPendingBalancesEthers(aliceSignedDenom, aliceAccount);
        console.log('After deposit pending balance is ', decryptedPendingBalance);
        const timeAfterDecrypt = new Date().getTime();
        console.log('Time to decrypt pending balance is ', (timeAfterDecrypt - timeBeforeDecrypt) / 1000, 'seconds');


        const decyptedAvailableBalance = await decryptAvailableBalanceEthers(aliceSignedDenom, aliceAccount);
        console.log('After deposit available balance is ', decyptedAvailableBalance);

        const receipt = await applyPendingBalanceEthers(alice.evmAddress, 'usei', aliceSignedDenom, alice.evmWallet.wallet);
        console.log(receipt);
        console.log('Applied pending balance now');
        await confidentialTransferEthers(alice.evmAddress, admin.evmAddress, 'usei', 14000000000, aliceSignedDenom, alice.evmWallet.wallet);
        console.log('Transferred 14000sei to admin');

        const aliceAccountAfter = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;
        // transfers 14000sei to admin
        const timeToAvailableBalance = new Date().getTime();
        const decryptedAvailableBalanceAfter = await decryptAvailableBalanceEthers(aliceSignedDenom, aliceAccountAfter);
        console.log('After apply available balance is ', decryptedAvailableBalanceAfter);
        const timeForAvailableBalance = new Date().getTime();
        console.log('Time to decrypt available balance is ', (timeForAvailableBalance - timeToAvailableBalance) / 1000, 'seconds');

        const timeBeforeFullDecrypt = new Date().getTime();
        const accountInf = await decryptAccountEthers(aliceSignedDenom, aliceAccountAfter, true);
        const timeAfterFullDecrypt = new Date().getTime();
        console.log('Time to decrypt full balance is ', (timeAfterFullDecrypt - timeBeforeFullDecrypt) / 1000, 'seconds');
        console.log(accountInf);
    });

    let transferBlock: number;
    it('Alice cant send tokens to uninitialized Ferdie', async () => {
        console.log('Started transferring ethers');
        const tx = await confidentialTransferEthers(alice.evmAddress, ferdie.evmAddress, 'usei', 500000, aliceSignedDenom, alice.evmWallet.wallet);
        console.log(tx);
    });

    it('Admin can withdraw tokens on usei', async () => {
        const aliceBalance = await alice.evmWallet.queryBalance();
        await withdrawFromPrivateBalanceEthers(alice.evmAddress, 'usei', 400000, aliceSignedDenom, alice.evmWallet.wallet);
        const aliceAfterBalance = await alice.evmWallet.queryBalance();
        console.log(ethers.formatEther(aliceAfterBalance - aliceBalance));
    });

    it('Admin cant close account with available balance in it', async () =>{
        await closeAccountEthers(alice.evmAddress, 'usei', aliceSignedDenom, alice.evmWallet.wallet);
    });

    it.skip('Admin can close account balance in it', async () =>{
        const aliceBalance = await alice.evmWallet.queryBalance();
        const tx = await withdrawFromPrivateBalanceEthers(alice.evmAddress, 'usei', 100000, aliceSignedDenom, alice.evmWallet.wallet);
        const aliceAfterBalance = await alice.evmWallet.queryBalance();
        await closeAccountEthers(alice.evmAddress, 'usei', aliceSignedDenom, alice.evmWallet.wallet);
        const account = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;
    });

    let transferBlockHeight = 319958;
    it.only('Can query the block on transfer', async () =>{
        const blockInfo = await rpcClient.getBlockByNumber(ethers.toQuantity(transferBlockHeight), true);
        console.log(blockInfo);
    });

    let txHash = "0x1cf2082dd110e805d7742efe1c945000ad71b9ea502dbebd19ddfdab8d4f63a3";
    let blockHash = "0x3fee0f50afa208cd659f8176658ffc7bf79b8c39b45b68d7e040886e43e73f7d";
    it.only('Can query the block with hash', async () => {
        const blockInfo = await rpcClient.getBlockByHash(blockHash, true);
        expect(blockInfo).to.exist;
        console.log(blockInfo);
    });

    it.only('Can query with tx receipt', async () =>{
        const txReceipt = await rpcClient.getTransactionReceipt(txHash);
        expect(txReceipt).to.exist;
        console.log(txReceipt);
    });

    it.only('Can debugtrace block in it', async () =>{
        const debugTraceTx = await rpcClient.debugTraceTransaction(txHash, {tracer: "callTracer"});
        expect(debugTraceTx).to.exist;
        console.log(debugTraceTx);
    });

    it.skip('Can trace the call', async () =>{
        const deployer = new TokenDeployer(admin);
        const erc20 = await deployer.deployErc20();
        const delayed = async () =>{
            await waitFor(1);
            return erc20.contract.mint(alice.evmAddress, ethers.parseEther('100'))
        }
        const txs = [
            confidentialTransferEthers(alice.evmAddress, bob.evmAddress, 'usei', 10000, aliceSignedDenom, alice.evmWallet.wallet),
            delayed()
        ];

        const results = await Promise.all(txs);
        const rec1 = results[0];
        const rec2 = await results[1].wait();

        //filter returns
        const erc20Contract = erc20.contract as unknown as TestERC20;
        const filter = erc20Contract.filters.Transfer();
        const logs = await erc20Contract.queryFilter(filter, rec1.blockNumber -10, 'latest');
        console.log(logs);

        const debugTraceByBlockNumber = await rpcClient.debugTraceByBlockNumber(ethers.toQuantity(213249), {tracer: "callTracer"});
        console.log(debugTraceByBlockNumber);
    });

})

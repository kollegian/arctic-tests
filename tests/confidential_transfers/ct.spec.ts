import {SeiUser, UserFactory} from "../../shared/User";
import * as TestConfig from "../../config/testConfig.json";
import {
    applyPendingBalanceEthers, closeAccountEthers,
    decryptAccountEthers,
    decryptAvailableBalanceEthers, decryptPendingBalancesEthers, depositEthers,
    getDenomToSignEthers,
    initializeAccountEthers,
    queryAccountEthers, transferEthers, withdrawEthers
} from "@sei-js/confidential-transfers";
import {expect} from "chai";
import {CtAccount} from "@sei-js/cosmos/dist/types/types/confidentialtransfers";
import {ethers} from "ethers";
import {waitFor} from "../../utils/helpers";
import {EvmRpcClient} from "../../shared/RpcClient";

describe('Confidential Transfers', function ()  {
    this.timeout(5 * 60 * 1000);
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
        alice = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
        await alice.initialize('', 'alice', true);
        bob = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
        await bob.initialize('', 'bob', true);

        ferdie = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
        await ferdie.initialize('', 'ferdie', true);

        await UserFactory.fundAddressOnSei(ferdie.seiAddress);
        await UserFactory.fundAddressOnSei(alice.seiAddress);
        await UserFactory.fundAddressOnSei(bob.seiAddress);
        await waitFor(1);
        await alice.seiWallet.associate();
        await bob.seiWallet.associate();

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
        const tx = await depositEthers('usei', 1000000, alice.evmWallet.wallet);
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
            await depositEthers('usei', 1000000, bob.evmWallet.wallet);
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
            await initializeAccountEthers(aliceSignedDenom, bob.evmAddress, 'usei', bob.evmWallet.wallet);
            const account = await queryAccountEthers(bob.evmAddress, 'usei', bob.evmWallet.wallet) as CtAccount;
        } catch (e: any){
            expect(e.message).to.contain('execution reverted');
        }
    });

    it('Alice can apply pending balances', async () =>{
        await applyPendingBalanceEthers(alice.evmAddress, 'usei', aliceSignedDenom, alice.evmWallet.wallet);
    });

    it('Alice can send tokens to initialized Bob', async () => {
        console.log('Started transferring ethers');
        const tx = await transferEthers(alice.evmAddress, bob.evmAddress, 'usei', 500000, aliceSignedDenom, alice.evmWallet.wallet);
        console.log(tx);
        console.log('Finished transferring ethers');
        console.log('Trying to decrypt the balance');
        const bobAccount = await queryAccountEthers(bob.evmAddress, 'usei', bob.evmWallet.wallet) as CtAccount;
        expect(bobAccount.pending_balance_credit_counter).to.be.eq(1);
        const decrypted = await decryptPendingBalancesEthers(bobSignedDenom, bobAccount);
        console.log(decrypted);
    });

    let transferBlock: number;
    it('Alice cant send tokens to uninitialized Ferdie', async () => {
        console.log('Started transferring ethers');
        await transferEthers(alice.evmAddress, ferdie.evmAddress, 'usei', 500000, aliceSignedDenom, alice.evmWallet.wallet);
    });

    it('Admin can withdraw tokens on usei', async () => {
        const aliceBalance = await alice.evmWallet.queryBalance();
        await withdrawEthers(alice.evmAddress, 'usei', 400000, aliceSignedDenom, alice.evmWallet.wallet);
        const aliceAfterBalance = await alice.evmWallet.queryBalance();
        console.log(aliceAfterBalance - aliceBalance);
    });

    it('Admin cant close account with available balance in it', async () =>{
        await closeAccountEthers(alice.evmAddress, 'usei', aliceSignedDenom, alice.evmWallet.wallet);
    });

    it('Admin can close account with pending balance in it', async () =>{
        const aliceBalance = await alice.evmWallet.queryBalance();
        const tx = await withdrawEthers(alice.evmAddress, 'usei', 100000, aliceSignedDenom, alice.evmWallet.wallet);
        const aliceAfterBalance = await alice.evmWallet.queryBalance();
        await closeAccountEthers(alice.evmAddress, 'usei', aliceSignedDenom, alice.evmWallet.wallet);
        const account = await queryAccountEthers(alice.evmAddress, 'usei', alice.evmWallet.wallet) as CtAccount;
    });

    let transferBlockHeight = 13362;
    it.skip('Can query the block on transfer', async () =>{
        const blockInfo = await rpcClient.getBlockByNumber(ethers.toQuantity(transferBlockHeight), true);
        console.log(blockInfo);
    });

    let txHash = "0xf0538e11dd03463d9b751aaa17d154a8b8735705642f1b5f560bb578f868b109";
    let blockHash = "0x958214c9c760081033a56ece03622236468de8e685069f570e8bf2eccaad8d2d";
    it.skip('Can query the block with hash', async () => {
        const blockInfo = await rpcClient.getBlockByHash(blockHash, true);
        console.log(blockInfo);
    });

    it.skip('Can query with tx receipt', async () =>{
        const txReceipt = await rpcClient.getTransactionReceipt(txHash);
        console.log(txReceipt);
    });

    it.skip('Can debugtrace block in it', async () =>{
        const debugTraceTx = await rpcClient.debugTraceTransaction(txHash, {tracer: "callTracer"});
        console.log(debugTraceTx);
    });

    it.skip('Can trace the call', async () =>{
        const trace = await rpcClient.debugTraceCall(txHash)
    });

})

import {Contract, ethers, formatEther} from "ethers";

import {SeiUser, UserFactory} from "../../shared/User";
import * as TestConfig from "../../config/testConfig.json";
import util from "node:util";
import {
    createTokenfactoryDenom,
    execCommandAndReturnJson,
    getCryptedBalance,
    getDecryptedBalance,
    getPayload
} from "../../utils/cliUtils";
import {expect} from "chai";
import {broadcastTx} from "../../utils/evmUtils";
import {createCtUsers} from "../../utils/helpers";

import * as CtAbi from "../../utils/abis/ct_abi.json";

const exec = util.promisify(require('node:child_process').exec);

const CT_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000001010";

describe('Can work on happy path for ct', function () {
    this.timeout(3 * 60 * 1000);
    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let ctContract: ethers.Contract;
    let denomName: string;
    let ctModuleAddress: string;
    const abiPath = "../../utils/abis/ct_abi.json";

    before('Initializes clients and users', async () => {
        admin = await UserFactory.createAdminUser(TestConfig);
        ({alice, bob} = await createCtUsers(admin));
        //@ts-ignore
        ctContract = new Contract(CT_CONTRACT_ADDRESS, CtAbi, admin.evmWallet.wallet);
        denomName = await createTokenfactoryDenom(alice, admin);

        const {stdout} = await exec(`seid q auth accounts --output json | jq -r '.accounts[] | select(.name == "confidentialtransfers") | .base_account.address'`);
        ctModuleAddress = stdout.trim();
        console.log('CT Module address: ' + ctModuleAddress);
    });

    describe('Happy path tests', function () {
        let aliceUseiPublicKey: string;
        const depositAmount = '25000'
        const transferAmount = '1000'

        it('Alice can initialize ct account on precompile', async () => {
            const payload = await getPayload().initializeAccount(alice);
            try {
                await execCommandAndReturnJson(`seid q ct account usei ${alice.seiAddress}`);
                throw new Error("Alice account should not exist");
            } catch (e: any) {
                expect(e.message).to.contain("not found");
            }

            const receipt = await broadcastTx(alice, payload.stdout, CT_CONTRACT_ADDRESS);
            expect(receipt!.status).to.equal(1);

            const aliceAccount = await execCommandAndReturnJson(`seid q ct account usei ${alice.seiAddress}`);
            expect(aliceAccount.public_key).to.have.length(44);
            expect(aliceAccount).to.have.property('pending_balance_lo');
            expect(aliceAccount.pending_balance_lo).to.have.property('c');
            expect(aliceAccount.pending_balance_lo).to.have.property('d');
            expect(aliceAccount).to.have.property('pending_balance_hi');
            expect(aliceAccount.pending_balance_hi).to.have.property('c');
            expect(aliceAccount.pending_balance_hi).to.have.property('d');
            expect(aliceAccount.pending_balance_credit_counter).to.be.eq(0);
            expect(aliceAccount).to.have.property('available_balance');
            expect(aliceAccount.available_balance).to.have.property('c');
            expect(aliceAccount.available_balance).to.have.property('d');
            expect(aliceAccount).to.have.property('decryptable_available_balance');
            expect(aliceAccount.decryptable_available_balance).to.have.length(40);

            aliceUseiPublicKey = aliceAccount.public_key;
        });

        it('After successful initialization Alice can query the account with decrypt', async () => {
            const aliceAccountDecrypted = await getDecryptedBalance(alice);
            expect(aliceAccountDecrypted.public_key).to.be.eq(aliceUseiPublicKey);
            expect(aliceAccountDecrypted.pending_balance_lo).to.be.eq('0');
            expect(aliceAccountDecrypted.pending_balance_hi).to.be.eq('0');
            expect(aliceAccountDecrypted.combined_pending_balance).to.be.eq('0');

            expect(aliceAccountDecrypted.available_balance).to.be.eq('0');
            expect(aliceAccountDecrypted.decryptable_available_balance).to.be.eq('0');
            expect(aliceAccountDecrypted.pending_balance_credit_counter).to.be.eq(0);
        });

        it('Alice can deposit tokens to ct account on precompile', async () => {
            const payload = await getPayload().deposit('usei', depositAmount);
            const receipt = await broadcastTx(alice, payload.stdout, CT_CONTRACT_ADDRESS);
            expect(receipt!.status).to.equal(1);

            const aliceAccountDecrypted = await getDecryptedBalance(alice);
            expect(aliceAccountDecrypted.pending_balance_credit_counter).to.be.eq(1);
            expect(aliceAccountDecrypted.combined_pending_balance).to.be.eq(depositAmount);
            expect(aliceAccountDecrypted.available_balance).to.be.eq('0');
        });

        it('Alice can apply pending balance to ct account on precompile', async () => {
            const payload = await getPayload().applyPendingBalances(alice);
            const receipt = await broadcastTx(alice, payload.stdout, CT_CONTRACT_ADDRESS);

            const aliceAccountDecrypted = await getDecryptedBalance(alice);
            expect(aliceAccountDecrypted.pending_balance_credit_counter).to.be.eq(0);
            expect(aliceAccountDecrypted.available_balance).to.be.eq(depositAmount);
            expect(aliceAccountDecrypted.combined_pending_balance).to.be.eq('0');
        })

        it('Alice can transfer tokens to bob on precompile', async () => {
            const bobPayload = await getPayload().initializeAccount(bob, 'usei');
            const receipt = await broadcastTx(bob, bobPayload.stdout, CT_CONTRACT_ADDRESS);
            expect(receipt!.status).to.equal(1);

            const transferPayload = await getPayload().transfer(alice, bob, 'usei', '1000');
            await broadcastTx(alice, transferPayload.stdout, CT_CONTRACT_ADDRESS);

            const aliceAccountDecrypted = await getDecryptedBalance(alice);
            expect(aliceAccountDecrypted.pending_balance_credit_counter).to.be.eq(0);
            expect(Number(aliceAccountDecrypted.available_balance)).to.be.eq(Number(depositAmount) - Number(transferAmount));
            expect(aliceAccountDecrypted.combined_pending_balance).to.be.eq('0');

            const adminAccountDecrypted = await getDecryptedBalance(bob);
            expect(adminAccountDecrypted.pending_balance_credit_counter).to.be.eq(1);
            expect(Number(adminAccountDecrypted.available_balance)).to.be.eq(Number('0'));
            expect(adminAccountDecrypted.combined_pending_balance).to.be.eq(transferAmount);
        });

        it('Alice can receive tokens from bob on precompile', async () => {
            const payload = await getPayload().applyPendingBalances(bob, 'usei');
            const receipt = await broadcastTx(bob, payload.stdout, CT_CONTRACT_ADDRESS);

            const transferPayload = await getPayload().transfer(bob, alice, 'usei', '1000');
            const depositReceipt = await broadcastTx(bob, transferPayload.stdout, CT_CONTRACT_ADDRESS);
            console.log('Transfer went fine');

            const aliceAccountDecrypted = await getDecryptedBalance(alice);
            expect(aliceAccountDecrypted.pending_balance_credit_counter).to.be.eq(1);
            expect(Number(aliceAccountDecrypted.available_balance)).to.be.eq(Number(depositAmount) - Number(transferAmount));
            expect(aliceAccountDecrypted.combined_pending_balance).to.be.eq(transferAmount);

            const adminAccountDecrypted = await getDecryptedBalance(bob);
            expect(adminAccountDecrypted.pending_balance_credit_counter).to.be.eq(0);
            expect(Number(adminAccountDecrypted.available_balance)).to.be.eq(0);
            expect(adminAccountDecrypted.combined_pending_balance).to.be.eq('0');
        });

        it('Alice can withdraw tokens from ct account on precompile', async () => {
            const payload = await getPayload().withdrawFunds(alice, '2000', 'usei');
            const receipt = await broadcastTx(alice, payload.stdout, CT_CONTRACT_ADDRESS);

            const aliceAccountDecrypted = await getDecryptedBalance(alice);
            expect(aliceAccountDecrypted.pending_balance_credit_counter).to.be.eq(1);
            expect(Number(aliceAccountDecrypted.available_balance)).to.be.eq(Number(depositAmount) - 3000);
            expect(aliceAccountDecrypted.combined_pending_balance).to.be.eq(transferAmount);
        });

        it('Bob can close account', async () => {
            const closePayload = await getPayload().closeAccount(bob);
            const receipt = await broadcastTx(bob, closePayload.stdout, CT_CONTRACT_ADDRESS);

            try {
                const account = await execCommandAndReturnJson(`seid q ct account usei ${bob.seiAddress}`);
                throw new Error("Bob account should not exist");
            } catch (e: any) {
                expect(e.message).to.contain("not found");
            }
        });

        it('Alice cant close with funds in it', async () => {
            const closePayload = await getPayload().closeAccount(alice);
            try {
                await broadcastTx(alice, closePayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error("Alice account should not exist");
            } catch (e: any) {
                expect(e.message).to.contain("transaction execution reverted");
            }

            const applyPayload = await getPayload().applyPendingBalances(alice);
            await broadcastTx(alice, applyPayload.stdout, CT_CONTRACT_ADDRESS);
            console.log('Applied pending balance');

            const withdrawPayload = await getPayload().withdrawFunds(alice, '23000', 'usei');
            await broadcastTx(alice, withdrawPayload.stdout, CT_CONTRACT_ADDRESS);
            console.log('Withdrew funds');


            const closePayload2 = await getPayload().closeAccount(alice);
            await broadcastTx(alice, closePayload2.stdout, CT_CONTRACT_ADDRESS);
            console.log('Closed account');
            try {
                const account = await execCommandAndReturnJson(`seid q ct account usei ${alice.seiAddress}`);
                throw new Error("Bob account should not exist");
            } catch (e: any) {
                expect(e.message).to.contain("not found");
            }
        })
    });

    describe('Account initialization tests', function () {
        let alice: SeiUser;
        let bob: SeiUser;
        let ferdie: SeiUser;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await createCtUsers(admin));
            await UserFactory.fundAdminOnSei('uatom');
            console.info('Funded admin on sei for uatom');

        });

        it('Alice can create multiple accounts for multiple denoms', async () => {
            const payloadSei = await getPayload().initializeAccount(alice);
            await broadcastTx(alice, payloadSei.stdout, CT_CONTRACT_ADDRESS);

            const account = await execCommandAndReturnJson(`seid q ct account usei ${alice.seiAddress}`);
            expect(account).to.exist;

        });

        it('Associated Alice can call initialize account again and state is preserved', async () => {
            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            const aliceDecrypted = await getDecryptedBalance(alice);

            //Tries second time
            try{
                const initializePayload = await getPayload().initializeAccount(alice, 'usei');
                await broadcastTx(alice, initializePayload.stdout, CT_CONTRACT_ADDRESS);
            } catch(e: any){
                expect(e.message).to.contain("transaction execution reverted");
            }
            const aliceDecrypted2 = await getDecryptedBalance(alice);
            expect(JSON.stringify(aliceDecrypted)).to.equal(JSON.stringify(aliceDecrypted2));
        });

        it('Unassociated Ferdie can call initialize account', async () => {
            ferdie = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await UserFactory.fundAddressOnSei(ferdie.seiAddress, 'usei');
            const initializePayload = await getPayload().initializeAccount(ferdie, 'usei');
            await broadcastTx(ferdie, initializePayload.stdout, CT_CONTRACT_ADDRESS);
            // at this point he should be associated
            expect(await ferdie.seiWallet.isAssociated()).to.be.true;


            const applyBalancePayload = await getPayload().applyPendingBalances(alice);
            await broadcastTx(alice, applyBalancePayload.stdout, CT_CONTRACT_ADDRESS);

            const transferPayload = await getPayload().transfer(alice, ferdie, 'usei', '100000');
            await broadcastTx(alice, transferPayload.stdout, CT_CONTRACT_ADDRESS);

            const applyPendingBalancePayload = await getPayload().applyPendingBalances(ferdie);
            await broadcastTx(ferdie, applyPendingBalancePayload.stdout, CT_CONTRACT_ADDRESS);

            const withdrawBalancePayload = await getPayload().withdrawFunds(ferdie, '100000', 'usei',);
            await broadcastTx(ferdie, withdrawBalancePayload.stdout, CT_CONTRACT_ADDRESS);
        });

        it('Ferdie calls to close bobs account', async () =>{
            const initAccountPayload = await getPayload().initializeAccount(bob, 'usei');
            await broadcastTx(bob, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            console.log('Bob account initialized');

            try{
                const closePayload = await getPayload().closeAccount(bob);
                await broadcastTx(ferdie, closePayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail')
            } catch(e: any){
                expect(e.message).to.contain('transaction execution reverted');
            }
        });

        it('Zero balance accounts cant be initialized', async () => {
            const initAccountPayload = await getPayload().initializeAccount(alice, 'autom');
            try{
                await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail');
            } catch(e: any){
                console.log(e.message);
            }
        });
    });

    describe('Deposit tests', function () {
        let alice: SeiUser;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await createCtUsers(admin));
        })

        it('Alice cant deposit tokens before initialization', async () => {
            const depositPayload = await getPayload().deposit('usei', '100000');
            try{
                await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail');
            } catch (e: any){
                expect(e.message).to.contain('transaction execution reverted');
            }

            // after failure alice can use the module as expected
            const initAccountPayload = await getPayload().initializeAccount(alice, 'usei');
            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            const depositPayload2 = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositPayload2.stdout, CT_CONTRACT_ADDRESS);

            const balance = await getDecryptedBalance(alice);
            expect(balance.combined_pending_balance).to.equal('100000');
            expect(balance.pending_balance_credit_counter).to.be.eq(1);
        });

        it.skip('Alice cant deposit minus tokens', async () => {
            const depositPayload = await getPayload().deposit('usei', '-100000');
            try{
                await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail');
            } catch (e: any){
                console.log(e.message);
            }
        });

        it('Alice cant deposit tokens for unitialized accounts', async () =>{
            const depositPayload = await getPayload().deposit('uatom', '100000');
            try{
                await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail');
            } catch (e: any){
                expect(e.message).to.contain('transaction execution reverted');
            }
        });

        it('Alice can hold multiple denoms on ct module', async () => {
            const balanceUsei = await getDecryptedBalance(alice);
            expect(balanceUsei.combined_pending_balance).to.equal('100000');
            expect(balanceUsei.pending_balance_credit_counter).to.be.eq(1);
        });

        it('Alice cant deposit more than her balance', async () =>{
            const depositPayload = await getPayload().deposit('usei', '250000000000');
            try{
                await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail');
            } catch(e: any){
                expect(e.message).to.contain('transaction execution reverted');
            }

        });
    });

    describe('Apply Balance Tests', function () {
        let alice: SeiUser;
        let bob: SeiUser;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await createCtUsers(admin));
            const initAccountPayload = await getPayload().initializeAccount(alice, 'usei');
            const initAccountPayload2 = await getPayload().initializeAccount(bob, 'usei');
            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            await broadcastTx(bob, initAccountPayload2.stdout, CT_CONTRACT_ADDRESS);
            console.log('Alice and Bob are initialized for usei');
        });

        it('Alice cant apply pending balance on zero balance', async () => {
            try{
                const applyPayload = await getPayload().applyPendingBalances(alice);
                throw new Error('Should fail');
            } catch (e: any){
                expect(e.message).to.contain('Command failed');
            }
        });

        it('Bob cant call apply pending balance on Alice', async () => {
            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload = await getPayload().applyPendingBalances(alice);
            try{
                await broadcastTx(alice, applyPayload.stdout, CT_CONTRACT_ADDRESS);
            } catch(e: any){
                expect(e.message).to.contain('transaction execution reverted');
            }
        });

        it('Alice can apply pending balance on multiple transfers', async () => {
            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload = await getPayload().applyPendingBalances(alice);
            await broadcastTx(alice, applyPayload.stdout, CT_CONTRACT_ADDRESS);

            const balance = await getDecryptedBalance(alice);
            expect(balance.combined_pending_balance).to.equal('0');
            expect(balance.pending_balance_credit_counter).to.be.eq(0);
            expect(balance.available_balance).to.equal('200000');
            expect(balance.decryptable_available_balance).to.equal('200000');

            const cryptedBalance = await getCryptedBalance(alice, 'usei');
            expect(cryptedBalance.pending_balance_credit_counter).to.equal(0);
        });

        it('Unassociated Ferdie can call apply pending balance', async () => {
            const ferdie = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await UserFactory.fundAddressOnSei(ferdie.seiAddress, 'usei');
            const initAccountPayload = await getPayload().initializeAccount(ferdie, 'usei');
            await broadcastTx(ferdie, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);

            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(ferdie, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload = await getPayload().applyPendingBalances(ferdie);
            await broadcastTx(ferdie, applyPayload.stdout, CT_CONTRACT_ADDRESS);
        })

        it.skip('Before applying pending balance, Alice cant transfer tokens', async () =>{
            const depositTx = await getPayload().deposit('uatom', '100000');
            await broadcastTx(alice, depositTx.stdout, CT_CONTRACT_ADDRESS);
            try{
                const transferTx = await getPayload().transfer(alice, bob, 'uatom', '100000');
                throw new Error('Should fail');
            } catch(e: any){
                console.log(e.message);
                expect(e.message).to.contain('Command failed');
            }
        });

        it('Pending balance applies for only one denom', async () =>{
            const depositTx = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositTx.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload = await getPayload().applyPendingBalances(alice);
            await broadcastTx(alice, applyPayload.stdout, CT_CONTRACT_ADDRESS);

            const balance = await getDecryptedBalance(alice);
            expect(balance.combined_pending_balance).to.equal('0');
            expect(balance.pending_balance_credit_counter).to.be.eq(0);
        });
    })

    describe('Transfer Tests', function () {
        let alice: SeiUser;
        let bob: SeiUser;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await createCtUsers(admin));

            const initAccountPayload = await getPayload().initializeAccount(alice, 'usei');
            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            const initAccountPayload2 = await getPayload().initializeAccount(bob, 'usei');
            await broadcastTx(bob, initAccountPayload2.stdout, CT_CONTRACT_ADDRESS);
        })

        it('Uninitialized accounts cant transfer tokens', async () => {
            const ferdie = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await UserFactory.fundAddressOnSei(ferdie.seiAddress, 'usei');
            try{
                const transferPayload = await getPayload().transfer(ferdie, bob, 'usei', '1000');
            } catch(e: any){
                expect(e.message).to.contain('Command failed');
            }
        })

        it('Alice can transfer tokens to bob', async () => {
            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);
            await broadcastTx(bob, depositPayload.stdout, CT_CONTRACT_ADDRESS);


            const applyPayload = await getPayload().applyPendingBalances(alice);
            await broadcastTx(alice, applyPayload.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload2 = await getPayload().applyPendingBalances(bob);
            await broadcastTx(bob, applyPayload2.stdout, CT_CONTRACT_ADDRESS);

            const transferPayload = await getPayload().transfer(alice, bob, 'usei', '50000');

            const receipts = await Promise.all([
                broadcastTx(alice, transferPayload.stdout, CT_CONTRACT_ADDRESS),
            ]);

            const balanceAlice = await getDecryptedBalance(alice, 'usei');
            expect(balanceAlice.combined_pending_balance).to.equal('0');
            expect(balanceAlice.pending_balance_credit_counter).to.be.eq(0);
            expect(balanceAlice.available_balance).to.equal('50000');

            const balanceBob = await getDecryptedBalance(bob, 'usei');
            expect(balanceBob.combined_pending_balance).to.equal('50000');
            expect(balanceBob.pending_balance_credit_counter).to.be.eq(1);
            expect(balanceBob.available_balance).to.equal('100000');
        });


        it('Unassociated Ferdie can receive tokens', async () => {
            let ferdie = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await UserFactory.fundAddressOnSei(ferdie.seiAddress, 'usei');
            const initAccountPayload = await getPayload().initializeAccount(ferdie, 'usei');
            await broadcastTx(ferdie, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);

            const transferPayload = await getPayload().transfer(alice, ferdie, 'usei', '30000');
            await broadcastTx(alice, transferPayload.stdout, CT_CONTRACT_ADDRESS);

            const ferdieBalance = await getDecryptedBalance(ferdie, 'usei');
            expect(ferdieBalance.combined_pending_balance).to.equal('30000');
            expect(ferdieBalance.pending_balance_credit_counter).to.be.eq(1);
        });

        it('With pending deposits, transfers work as expected', async () => {
            let ferdie = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await UserFactory.fundAddressOnSei(ferdie.seiAddress, 'usei');
            const initAccountPayload = await getPayload().initializeAccount(ferdie, 'usei');
            await broadcastTx(ferdie, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);

            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(ferdie, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload = await getPayload().applyPendingBalances(ferdie);
            await broadcastTx(ferdie, applyPayload.stdout, CT_CONTRACT_ADDRESS);

            const transferPayload = await getPayload().transfer(alice, ferdie, 'usei', '20000');
            await broadcastTx(alice, transferPayload.stdout, CT_CONTRACT_ADDRESS);

            const ferdieBalance = await getDecryptedBalance(ferdie, 'usei');
            expect(ferdieBalance.combined_pending_balance).to.equal('20000');
            expect(ferdieBalance.pending_balance_credit_counter).to.be.eq(1);
            expect(ferdieBalance.available_balance).to.equal('100000');

            const transferPayload2 = await getPayload().transfer(ferdie, bob, 'usei', '50000');
            await broadcastTx(ferdie, transferPayload2.stdout, CT_CONTRACT_ADDRESS);

            const ferdieBalance2 = await getDecryptedBalance(ferdie, 'usei');
            expect(ferdieBalance2.combined_pending_balance).to.equal('20000');
            expect(ferdieBalance2.pending_balance_credit_counter).to.be.eq(1);
            expect(ferdieBalance2.available_balance).to.equal('50000');
            expect(ferdieBalance2.decryptable_available_balance).to.equal('50000');

            const bobBalance = await getDecryptedBalance(bob, 'usei');
            expect(bobBalance.combined_pending_balance).to.equal('100000');
            expect(bobBalance.pending_balance_credit_counter).to.be.eq(2);
            expect(bobBalance.available_balance).to.equal('100000');
        });
    })

    describe('Withdraw Tests', function () {
        let alice: SeiUser;
        let bob: SeiUser;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await createCtUsers(admin));

            const initAccountPayload = await getPayload().initializeAccount(alice, 'usei');
            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            const initAccountPayload2 = await getPayload().initializeAccount(bob, 'usei');
            await broadcastTx(bob, initAccountPayload2.stdout, CT_CONTRACT_ADDRESS);
        })

        it('Alice cant withdraw tokens from uninitialized account', async () => {
            const depositTx = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositTx.stdout, CT_CONTRACT_ADDRESS);

            try{
                const payload = await getPayload().withdrawFunds(alice, '10000', 'uatom');
                throw new Error('Should fail');
            } catch(e: any) {
                expect(e.message).to.contain('Command failed');
            }
        });

        it('Unassociated Ferdie can withdraw tokens', async () => {
            const ferdie = new SeiUser(admin.seiRpcEndpoint, admin.evmRpcEndpoint, admin.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await UserFactory.fundAddressOnSei(ferdie.seiAddress, 'usei');
            const initAccountPayload = await getPayload().initializeAccount(ferdie, 'usei');
            await broadcastTx(ferdie, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);

            const depositTx = await getPayload().deposit('usei', '100000');
            await broadcastTx(ferdie, depositTx.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload = await getPayload().applyPendingBalances(ferdie);
            await broadcastTx(ferdie, applyPayload.stdout, CT_CONTRACT_ADDRESS);
            const ferdieSeiBalance = await ferdie.seiWallet.queryBalance();

            const withdrawPayload = await getPayload().withdrawFunds(ferdie, '10000', 'usei');
            const receipt = await broadcastTx(ferdie, withdrawPayload.stdout, CT_CONTRACT_ADDRESS);
            const paidGas = Number(receipt.gasUsed) * parseFloat(formatEther(receipt.gasPrice));
            const expectedIncrease = (0.01 - paidGas) * 10 ** 6;
            const ferdieSeiBalance2 = await ferdie.seiWallet.queryBalance();
            expect(Number(ferdieSeiBalance2.amount)).to.be.within(Number(ferdieSeiBalance.amount) + expectedIncrease - 100,
                Number(ferdieSeiBalance.amount) + expectedIncrease + 100);
        });

        it('Alice cant withdraw tokens from unexisting denom', async () =>{
            try{
                const payload = await getPayload().withdrawFunds(alice, '10000', 'utest');
                throw new Error('Should fail');
            } catch(e: any){
                expect(e.message).to.contain('account not found for account');
            }
        });

        it('Alice can withdraw usei given that she has multiple denoms', async () => {
            const depositTx = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositTx.stdout, CT_CONTRACT_ADDRESS);

            const pendingBalance = await getPayload().applyPendingBalances(alice);
            await broadcastTx(alice, pendingBalance.stdout, CT_CONTRACT_ADDRESS);
            const moduleBalance = await exec(`seid q bank balances ${ctModuleAddress} --denom usei --output json`);
            const withdrawPayload = await getPayload().withdrawFunds(alice, '10000', 'usei');
            await broadcastTx(alice, withdrawPayload.stdout, CT_CONTRACT_ADDRESS);
            const moduleBalanceAfter = await exec(`seid q bank balances ${ctModuleAddress} --denom usei --output json`);

            expect(Number(JSON.parse(moduleBalance.stdout).amount)).to.be.eq(Number(JSON.parse(moduleBalanceAfter.stdout).amount) + 10000);
        });

        it('Alice cant withdraw more than her balance', async () =>{
            try {
                const payload = await getPayload().withdrawFunds(alice, '15000000', 'usei');
            } catch(e: any){
                expect(e.message).to.contain('Error: insufficient balance');
            }
        });

        it.skip('Alice cant withdraw pending balance', async () =>{
            const depositTx = await getPayload().deposit('uatom', '100000');
            await broadcastTx(alice, depositTx.stdout, CT_CONTRACT_ADDRESS);
            try{
                const withdrawPayload = await getPayload().withdrawFunds(alice, '150000', 'uatom');
            } catch(e: any){
                expect(e.message).to.contain('insufficient balance');
            }
        });
    })

    describe.only('Account close tests', function () {
        let alice: SeiUser;
        let bob: SeiUser;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await createCtUsers(admin));

            const initAccountPayload = await getPayload().initializeAccount(alice, 'usei');
            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            const initAccountPayload2 = await getPayload().initializeAccount(bob, 'usei');
            await broadcastTx(bob, initAccountPayload2.stdout, CT_CONTRACT_ADDRESS);

        })

        it('If a user has available balance, it cant be closed', async () => {
            const depositTx = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositTx.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload = await getPayload().applyPendingBalances(alice);
            await broadcastTx(alice, applyPayload.stdout, CT_CONTRACT_ADDRESS);

            try{
                const closePayload = await getPayload().closeAccount(alice);
                await broadcastTx(alice, closePayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail');
            } catch(e: any){
                expect(e.message).to.contain('transaction execution reverted');
            }
        });

        it.skip('If a user has pending balance, it cant be closed', async () => {
            const depositTx = await getPayload().deposit('uatom', '100000');
            await broadcastTx(alice, depositTx.stdout, CT_CONTRACT_ADDRESS);

            const decryptedBalance = await getDecryptedBalance(alice, 'uatom');
            console.log(decryptedBalance);

            try{
                const closePayload = await getPayload().closeAccount(alice, 'uatom');
                await broadcastTx(alice, closePayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail');
            } catch(e: any){
                console.log(e);
            }
        });

        it('If a user has pending balance and available balance, it cant be closed', async () => {
            const depositTx = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositTx.stdout, CT_CONTRACT_ADDRESS);

            try{
                const closePayload = await getPayload().closeAccount(alice);
                await broadcastTx(alice, closePayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail');
            } catch(e: any){
                expect(e.message).to.contain('transaction execution reverted');
            }
        });

        it('It can be closed without any interaction to the module', async () =>{
            const closePayload = await getPayload().closeAccount(bob);
            await broadcastTx(bob, closePayload.stdout, CT_CONTRACT_ADDRESS);
            try{
                const decryptedBalance = await getDecryptedBalance(bob, 'usei');
                throw new Error('Should fail');
            } catch(e: any){
                expect(e.message).to.contain('Command failed');
            }
        });

        it('Can reopen accounts', async () =>{
            const initPayload = await getPayload().initializeAccount(bob);
            await broadcastTx(bob, initPayload.stdout, CT_CONTRACT_ADDRESS);

            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(bob, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            const decryptedBalance = await getDecryptedBalance(bob, 'usei');
            expect(decryptedBalance.combined_pending_balance).to.equal('100000');
            expect(decryptedBalance.pending_balance_credit_counter).to.be.eq(1);
            expect(decryptedBalance.decryptable_available_balance).to.equal('0');
        })
    })
})

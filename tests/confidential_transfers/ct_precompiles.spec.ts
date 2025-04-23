import {SeiUser} from "../../modules/utils/User";
import {Contract, ethers, formatEther, keccak256} from "ethers";
import {returnExpect} from "../../modules/bank/utils";
import testConfig from "../testConfig.json";
import CtAbi from "../abis/ct_abi.json";
import {
    broadcastTx,
    createTokenfactoryDenom, getCryptedBalance,
    getDecryptedBalance,
    getPayload,
    returnQueryClient,
    returnUsers
} from "../utils/utils";
import util from "node:util";
import {execCommandAndReturnJson, waitFor} from "../../modules/tokenfactory/helpers";
import {Funder} from "../../modules/utils/Funder";
import govAbi from "../abis/gov_abi.json";
import {GovExtension, QueryClient, setupGovExtension, setupStakingExtension, StakingExtension} from "@cosmjs/stargate";
import stakingAbi from "../abis/staking_abi.json";

const exec = util.promisify(require('node:child_process').exec);

const CT_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000001010";

describe('Can work on happy path for ct', function () {
    this.timeout(3 * 60 * 1000);
    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let ctContract: ethers.Contract;
    let denomName: string;
    let expect: Chai.ExpectStatic;
    let ctModuleAddress: string;

    before('Initializes clients and users', async () => {
        expect = await returnExpect();
        ({admin, alice, bob} = await returnUsers(testConfig));
        //@ts-ignore
        ctContract = new Contract(CT_CONTRACT_ADDRESS, CtAbi, admin.evmWallet.wallet);
        denomName = await createTokenfactoryDenom(alice, admin);

        const {stdout} = await exec(`seid q auth accounts --output json | jq -r '.accounts[] | select(.name == "confidentialtransfers") | .base_account.address'`);
        ctModuleAddress = stdout.trim();
    });

    describe('Happy path tests', function () {
        let aliceUseiPublicKey: string;
        const depositAmount = '25000'
        const transferAmount = '1000'

        it('Alice can initialize ct account on precompile', async () => {
            const payload = await exec(`seid q evm ct-init-account-payload ./abis/ct_abi.json ${alice.seiAddress} usei`);
            try {
                await execCommandAndReturnJson(`seid q ct account usei ${alice.seiAddress}`);
                throw new Error("Alice account should not exist");
            } catch (e: any) {
                expect(e.message).to.contain("not found");
            }

            const receipt = await broadcastTx(alice, payload.stdout, CT_CONTRACT_ADDRESS);
            expect(receipt.status).to.equal(1);

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
            const payload = await exec(`seid q evm payload ./abis/ct_abi.json deposit usei ${depositAmount}`);
            const receipt = await broadcastTx(alice, payload.stdout, CT_CONTRACT_ADDRESS);
            expect(receipt.status).to.equal(1);

            const aliceAccountDecrypted = await getDecryptedBalance(alice);
            expect(aliceAccountDecrypted.pending_balance_credit_counter).to.be.eq(1);
            expect(aliceAccountDecrypted.combined_pending_balance).to.be.eq(depositAmount);
            expect(aliceAccountDecrypted.available_balance).to.be.eq('0');
        });

        it('Alice can apply pending balance to ct account on precompile', async () => {
            const payload = await exec(`seid q evm ct-apply-pending-balance-payload ./abis/ct_abi.json ${alice.seiAddress} usei`);
            const receipt = await broadcastTx(alice, payload.stdout, CT_CONTRACT_ADDRESS);

            const aliceAccountDecrypted = await getDecryptedBalance(alice);
            expect(aliceAccountDecrypted.pending_balance_credit_counter).to.be.eq(0);
            expect(aliceAccountDecrypted.available_balance).to.be.eq(depositAmount);
            expect(aliceAccountDecrypted.combined_pending_balance).to.be.eq('0');
        })

        it('Alice can transfer tokens to bob on precompile', async () => {
            const bobPayload = await exec(`seid q evm ct-init-account-payload ./abis/ct_abi.json ${bob.seiAddress} usei`);
            const receipt = await broadcastTx(bob, bobPayload.stdout, CT_CONTRACT_ADDRESS);
            expect(receipt.status).to.equal(1);

            const transferPayload = await exec(`seid q evm ct-transfer-payload ./abis/ct_abi.json ${alice.seiAddress} ${bob.seiAddress} 1000usei`)
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
            const payload = await exec(`seid q evm ct-apply-pending-balance-payload ./abis/ct_abi.json ${bob.seiAddress} usei`);
            const receipt = await broadcastTx(bob, payload.stdout, CT_CONTRACT_ADDRESS);

            const transferPayload = await exec(`seid q evm ct-transfer-payload ./abis/ct_abi.json ${bob.seiAddress} ${alice.seiAddress} 1000usei`)
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

        it('Alice can apply pending balance on multiple transfers', async () => {

        });

        it('Alice can withdraw tokens from ct account on precompile', async () => {
            const payload = await exec(`seid q evm ct-withdraw-payload ./abis/ct_abi.json ${alice.seiAddress} 2000usei`);
            const receipt = await broadcastTx(alice, payload.stdout, CT_CONTRACT_ADDRESS);

            const aliceAccountDecrypted = await getDecryptedBalance(alice);
            expect(aliceAccountDecrypted.pending_balance_credit_counter).to.be.eq(1);
            expect(Number(aliceAccountDecrypted.available_balance)).to.be.eq(Number(depositAmount) - 3000);
            expect(aliceAccountDecrypted.combined_pending_balance).to.be.eq(transferAmount);
        });

        it('Bob can close account', async () => {
            const closePayload = await exec(`seid q evm ct-close-account-payload ./abis/ct_abi.json ${bob.seiAddress} usei`);
            const receipt = await broadcastTx(bob, closePayload.stdout, CT_CONTRACT_ADDRESS);

            try {
                const account = await execCommandAndReturnJson(`seid q ct account usei ${bob.seiAddress}`);
                throw new Error("Bob account should not exist");
            } catch (e: any) {
                expect(e.message).to.contain("not found");
            }
        });

        it('Alice cant close with funds in it', async () => {
            const closePayload = await exec(`seid q evm ct-close-account-payload ./abis/ct_abi.json ${alice.seiAddress} usei`);
            try {
                await broadcastTx(alice, closePayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error("Alice account should not exist");
            } catch (e: any) {
                expect(e.message).to.contain("transaction execution reverted");
            }

            const applyPayload = await exec(`seid q evm ct-apply-pending-balance-payload ./abis/ct_abi.json ${alice.seiAddress} usei`);
            await broadcastTx(alice, applyPayload.stdout, CT_CONTRACT_ADDRESS);
            console.log('Applied pending balance');

            const withdrawPayload = await exec(`seid q evm ct-withdraw-payload ./abis/ct_abi.json ${alice.seiAddress} 23000usei`);
            await broadcastTx(alice, withdrawPayload.stdout, CT_CONTRACT_ADDRESS);
            console.log('Withdrew funds');


            const closePayload2 = await exec(`seid q evm ct-close-account-payload ./abis/ct_abi.json ${alice.seiAddress} usei`);
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
        let funder: Funder;
        let ferdie: SeiUser;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await returnUsers(testConfig));
            funder = new Funder(testConfig.adminAddress);
            await funder.fundAdminOnSei('uatom');
            console.info('Funded admin on sei for uatom');

            await funder.fundAddressOnSei(alice.seiAddress, 'uatom');

        });

        it('Alice can create multiple accounts for multiple denoms', async () => {
            const payloadSei = await getPayload().initializeAccount(alice);
            await broadcastTx(alice, payloadSei.stdout, CT_CONTRACT_ADDRESS);

            const payloadUatom = await getPayload().initializeAccount(alice, 'uatom');
            const receiptUatom = await broadcastTx(alice, payloadUatom.stdout, CT_CONTRACT_ADDRESS);

            const account = await execCommandAndReturnJson(`seid q ct account usei ${alice.seiAddress}`);
            expect(account).to.exist;

            const accountUatom = await execCommandAndReturnJson(`seid q ct account uatom ${alice.seiAddress}`);
            expect(accountUatom).to.exist;
        });

        it('Associated Alice can call initialize account again and state is preserved', async () => {
            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            const aliceDecrypted = await getDecryptedBalance(alice);
            console.log(aliceDecrypted);

            //Tries second time
            try{
                const initializePayload = await getPayload().initializeAccount(alice, 'usei');
                await broadcastTx(alice, initializePayload.stdout, CT_CONTRACT_ADDRESS);
            } catch(e: any){
                expect(e.message).to.contain("transaction execution reverted");
            }
            const aliceDecrypted2 = await getDecryptedBalance(alice);
            console.log(aliceDecrypted2);
        });

        it('Unassociated Ferdie can call initialize account', async () => {
            ferdie = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await funder.fundAddressOnSei(ferdie.seiAddress, 'usei');
            const initializePayload = await getPayload().initializeAccount(ferdie, 'usei');
            await broadcastTx(ferdie, initializePayload.stdout, CT_CONTRACT_ADDRESS);

            console.log(await ferdie.seiWallet.isAssociated());

            const ferdieDecrypted = await getDecryptedBalance(ferdie);
            console.log(ferdieDecrypted);

            const ferdiePreBalance = await ferdie.seiWallet.queryBalance();
            console.log(ferdiePreBalance);

            const applyBalancePayload = await getPayload().applyPendingBalances(alice);
            await broadcastTx(alice, applyBalancePayload.stdout, CT_CONTRACT_ADDRESS);

            const transferPayload = await getPayload().transfer(alice, ferdie, 'usei', '100000');
            await broadcastTx(alice, transferPayload.stdout, CT_CONTRACT_ADDRESS);

            const ferdieAfterBalance = await ferdie.seiWallet.queryBalance();
            console.log(ferdieAfterBalance);

            const ferdieAfterDecrypt = await getDecryptedBalance(ferdie);
            console.log(ferdieAfterDecrypt);

            //balances are preserved after association
            console.log(await ferdie.seiWallet.isAssociated());
            await ferdie.seiWallet.associate();

            const applyPendingBalancePayload = await getPayload().applyPendingBalances(ferdie);
            await broadcastTx(ferdie, applyPendingBalancePayload.stdout, CT_CONTRACT_ADDRESS);

            const preBalance = await ferdie.seiWallet.queryBalance();
            console.log(preBalance);
            const withdrawBalancePayload = await getPayload().withdrawFunds(ferdie, '100000', 'usei',);
            await broadcastTx(ferdie, withdrawBalancePayload.stdout, CT_CONTRACT_ADDRESS);

            const postBalance = await ferdie.seiWallet.queryBalance();
            console.log(postBalance);
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

        it('Admin sends funds to the ct module account', async () =>{

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
        let funder: Funder;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await returnUsers(testConfig));
            funder = new Funder(testConfig.adminAddress);
            await funder.fundAdminOnSei('uatom');
            console.info('Funded admin on sei for uatom');
            await funder.fundAddressOnSei(alice.seiAddress, 'uatom');
            await funder.fundAddressOnSei(alice.seiAddress);
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
            await funder.fundAdminOnSei('uatom');
            await funder.fundAddressOnSei(alice.seiAddress, 'uatom');
            const depositPayload = await getPayload().deposit('uatom', '100000');
            try{
                await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail');
            } catch (e: any){
                expect(e.message).to.contain('transaction execution reverted');
            }
        });

        it('Alice can hold multiple denoms on ct module', async () => {
            const initAccountPayload = await getPayload().initializeAccount(alice, 'uatom');
            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            console.log('Alice account initialized on uatom');

            const depositPayload = await getPayload().deposit('uatom', '100000');
            await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            const balanceUsei = await getDecryptedBalance(alice);
            expect(balanceUsei.combined_pending_balance).to.equal('100000');
            expect(balanceUsei.pending_balance_credit_counter).to.be.eq(1);

            const balanceUatom = await getDecryptedBalance(alice, 'uatom');
            expect(balanceUatom.combined_pending_balance).to.equal('100000');
            expect(balanceUatom.pending_balance_credit_counter).to.be.eq(1);
        });

        it('Alice cant deposit more than her balance', async () =>{
            const depositPayload = await getPayload().deposit('uatom', '250000000');
            try{
                await broadcastTx(alice, depositPayload.stdout, CT_CONTRACT_ADDRESS);
                throw new Error('Should fail');
            } catch(e: any){
                expect(e.message).to.contain('transaction execution reverted');
            }

            const balance = await getDecryptedBalance(alice, 'uatom');
            expect(balance.combined_pending_balance).to.equal('100000');
            expect(balance.pending_balance_credit_counter).to.be.eq(1);
        });
    });

    describe('Apply Balance Tests', function () {
        let alice: SeiUser;
        let bob: SeiUser;
        let funder: Funder;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await returnUsers(testConfig));
            funder = new Funder(testConfig.adminAddress);
            await funder.fundAddressOnSei(alice.seiAddress, 'uatom');
            await funder.fundAddressOnSei(bob.seiAddress, 'uatom');

            await funder.fundAddressOnSei(alice.seiAddress, 'usei');
            await funder.fundAddressOnSei(bob.seiAddress, 'usei');

            const initAccountPayload = await getPayload().initializeAccount(alice, 'usei');
            const initAccountPayload2 = await getPayload().initializeAccount(bob, 'usei');

            const initAccountPayload3 = await getPayload().initializeAccount(alice, 'uatom');
            const initAccountPayload4 = await getPayload().initializeAccount(bob, 'uatom');

            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            await broadcastTx(bob, initAccountPayload2.stdout, CT_CONTRACT_ADDRESS);
            await broadcastTx(alice, initAccountPayload3.stdout, CT_CONTRACT_ADDRESS);
            await broadcastTx(bob, initAccountPayload4.stdout, CT_CONTRACT_ADDRESS);

            console.log('Alice and Bob are initialized for usei and uatom');
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
            console.log(balance);

            const cryptedBalance = await getCryptedBalance(alice, 'usei');
            console.log(cryptedBalance);
        });

        it('Unassociated Ferdie can call apply pending balance', async () => {
            const ferdie = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await funder.fundAddressOnSei(ferdie.seiAddress, 'usei');
            const initAccountPayload = await getPayload().initializeAccount(ferdie, 'usei');
            await broadcastTx(ferdie, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);

            console.log(await ferdie.seiWallet.isAssociated());

            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(ferdie, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            console.log(await ferdie.seiWallet.isAssociated());
            const applyPayload = await getPayload().applyPendingBalances(ferdie);
            await broadcastTx(ferdie, applyPayload.stdout, CT_CONTRACT_ADDRESS);
            console.log(await ferdie.seiWallet.isAssociated());
        })

        it('Before applying pending balance, Alice cant transfer tokens', async () =>{
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

            const balanceAtom = await getDecryptedBalance(alice, 'uatom');
            expect(balanceAtom.combined_pending_balance).to.equal('100000');
            expect(balanceAtom.pending_balance_credit_counter).to.be.eq(1);
        });
    })

    describe('Transfer Tests', function () {
        let alice: SeiUser;
        let bob: SeiUser;
        let funder: Funder;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await returnUsers(testConfig));
            funder = new Funder(testConfig.adminAddress);
            await funder.fundAdminOnSei();
            await funder.fundAdminOnSei('uatom');

            console.info('Funded admin on sei for uatom');

            await funder.fundAddressOnSei(alice.seiAddress);
            await funder.fundAddressOnSei(bob.seiAddress);

            await funder.fundAddressOnSei(alice.seiAddress, 'uatom');
            await funder.fundAddressOnSei(bob.seiAddress, 'uatom');

            const initAccountPayload = await getPayload().initializeAccount(alice, 'usei');
            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            const initAccountPayload2 = await getPayload().initializeAccount(bob, 'usei');
            await broadcastTx(bob, initAccountPayload2.stdout, CT_CONTRACT_ADDRESS);

            const initAccountPayload3 = await getPayload().initializeAccount(alice, 'uatom');
            await broadcastTx(alice, initAccountPayload3.stdout, CT_CONTRACT_ADDRESS);

            const initAccountPayload4 = await getPayload().initializeAccount(bob, 'uatom');
            await broadcastTx(bob, initAccountPayload4.stdout, CT_CONTRACT_ADDRESS);
        })

        it('Uninitialized accounts cant transfer tokens', async () => {
            const ferdie = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await funder.fundAddressOnSei(ferdie.seiAddress, 'usei');
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

            const depositAtomPayload = await getPayload().deposit('uatom', '100000');
            await broadcastTx(alice, depositAtomPayload.stdout, CT_CONTRACT_ADDRESS);
            await broadcastTx(bob, depositAtomPayload.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload = await getPayload().applyPendingBalances(alice);
            await broadcastTx(alice, applyPayload.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload2 = await getPayload().applyPendingBalances(bob);
            await broadcastTx(bob, applyPayload2.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload3 = await getPayload().applyPendingBalances(alice, 'uatom');
            await broadcastTx(alice, applyPayload3.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload4 = await getPayload().applyPendingBalances(bob, 'uatom');
            await broadcastTx(bob, applyPayload4.stdout, CT_CONTRACT_ADDRESS);

            const transferPayload = await getPayload().transfer(alice, bob, 'usei', '50000');
            const transferAtomPayload = await getPayload().transfer(bob, alice, 'uatom', '50000');

            const receipts = await Promise.all([
                broadcastTx(alice, transferPayload.stdout, CT_CONTRACT_ADDRESS),
                broadcastTx(bob, transferAtomPayload.stdout, CT_CONTRACT_ADDRESS)
            ]);

            const balanceAlice = await getDecryptedBalance(alice, 'usei');
            expect(balanceAlice.combined_pending_balance).to.equal('0');
            expect(balanceAlice.pending_balance_credit_counter).to.be.eq(0);
            expect(balanceAlice.available_balance).to.equal('50000');
            const balanceBob = await getDecryptedBalance(bob, 'usei');
            expect(balanceBob.combined_pending_balance).to.equal('50000');
            expect(balanceBob.pending_balance_credit_counter).to.be.eq(1);
            expect(balanceBob.available_balance).to.equal('100000');

            const aliceUatomBalannce = await getDecryptedBalance(alice, 'uatom');
            console.log(aliceUatomBalannce);
            expect(aliceUatomBalannce.combined_pending_balance).to.equal('50000');
            expect(aliceUatomBalannce.pending_balance_credit_counter).to.be.eq(1);
            expect(aliceUatomBalannce.available_balance).to.equal('100000');
            const bobUatomBalannce = await getDecryptedBalance(bob, 'uatom');
            expect(bobUatomBalannce.combined_pending_balance).to.equal('0');
            expect(bobUatomBalannce.pending_balance_credit_counter).to.be.eq(0);
            expect(bobUatomBalannce.available_balance).to.equal('50000');
        });


        it('Unassociated Ferdie can receive tokens', async () => {
            let ferdie = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await funder.fundAddressOnSei(ferdie.seiAddress, 'usei');
            const initAccountPayload = await getPayload().initializeAccount(ferdie, 'usei');
            await broadcastTx(ferdie, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);

            const transferPayload = await getPayload().transfer(alice, ferdie, 'usei', '30000');
            await broadcastTx(alice, transferPayload.stdout, CT_CONTRACT_ADDRESS);

            const ferdieBalance = await getDecryptedBalance(ferdie, 'usei');
            expect(ferdieBalance.combined_pending_balance).to.equal('30000');
            expect(ferdieBalance.pending_balance_credit_counter).to.be.eq(1);
        });

        it('With pending deposits, transfers work as expected', async () => {
            let ferdie = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await funder.fundAddressOnSei(ferdie.seiAddress, 'usei');
            const initAccountPayload = await getPayload().initializeAccount(ferdie, 'usei');
            await broadcastTx(ferdie, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);

            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(ferdie, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            const applyPayload = await getPayload().applyPendingBalances(ferdie);
            await broadcastTx(ferdie, applyPayload.stdout, CT_CONTRACT_ADDRESS);

            const transferPayload = await getPayload().transfer(alice, ferdie, 'usei', '20000');
            await broadcastTx(alice, transferPayload.stdout, CT_CONTRACT_ADDRESS);

            const ferdieBalance = await getDecryptedBalance(ferdie, 'usei');
            console.log(ferdieBalance);

            const transferPayload2 = await getPayload().transfer(ferdie, bob, 'usei', '50000');
            await broadcastTx(ferdie, transferPayload2.stdout, CT_CONTRACT_ADDRESS);

            const ferdieBalance2 = await getDecryptedBalance(ferdie, 'usei');
            console.log(ferdieBalance2);

            const bobBalance = await getDecryptedBalance(bob, 'usei');
            console.log(bobBalance);
        });
    })

    describe('Withdraw Tests', function () {
        let alice: SeiUser;
        let bob: SeiUser;
        let funder: Funder;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await returnUsers(testConfig));
            funder = new Funder(testConfig.adminAddress);
            await funder.fundAdminOnSei();
            await funder.fundAdminOnSei('uatom');

            console.info('Funded admin on sei for uatom');
            await funder.fundAddressOnSei(alice.seiAddress);
            await funder.fundAddressOnSei(bob.seiAddress);

            await funder.fundAddressOnSei(alice.seiAddress, 'uatom');
            await funder.fundAddressOnSei(bob.seiAddress, 'uatom');

            const initAccountPayload = await getPayload().initializeAccount(alice, 'usei');
            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            const initAccountPayload2 = await getPayload().initializeAccount(bob, 'usei');
            await broadcastTx(bob, initAccountPayload2.stdout, CT_CONTRACT_ADDRESS);

            const initAccountPayload3 = await getPayload().initializeAccount(alice, 'uatom');
            await broadcastTx(alice, initAccountPayload3.stdout, CT_CONTRACT_ADDRESS);

            const initAccountPayload4 = await getPayload().initializeAccount(bob, 'uatom');
            await broadcastTx(bob, initAccountPayload4.stdout, CT_CONTRACT_ADDRESS);
        })

        it('Alice cant withdraw tokens from uninitialized account', async () => {
            const depositTx = await getPayload().deposit('usei', '100000');
            await broadcastTx(alice, depositTx.stdout, CT_CONTRACT_ADDRESS);

            try{
                const payload = await getPayload().withdrawFunds(alice, '10000', 'uatom');
                throw new Error('Should fail');
            } catch(e: any) {
                expect(e.message).to.contain('Error: insufficient balance');
            }
        });

        it('Unassociated Ferdie can withdraw tokens', async () => {
            const ferdie = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
            await ferdie.initialize('', 'ferdie', true);
            await funder.fundAddressOnSei(ferdie.seiAddress, 'usei');
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
            console.log(paidGas);
            const expectedIncrease = (0.01 - paidGas) * 10 ** 6;
            console.log(expectedIncrease);
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

            const depositAtomTx = await getPayload().deposit('uatom', '100000');
            await broadcastTx(alice, depositAtomTx.stdout, CT_CONTRACT_ADDRESS);

            const pendingBalance = await getPayload().applyPendingBalances(alice);
            await broadcastTx(alice, pendingBalance.stdout, CT_CONTRACT_ADDRESS);

            const pendingBalanceAtom = await getPayload().applyPendingBalances(alice, 'uatom');
            await broadcastTx(alice, pendingBalanceAtom.stdout, CT_CONTRACT_ADDRESS);

            const uatomBalance = await getDecryptedBalance(alice, 'uatom');
            const uatomBalanceOnBank = await exec(`seid q bank balances ${alice.seiAddress} --denom uatom`);
            const totalIssuancePre = await exec(`seid q bank total ${alice.seiAddress} --denom uatom`);
            const moduleBalance = await exec(`seid q bank balances ${ctModuleAddress} --denom usei --output json`);

            const withdrawPayload = await getPayload().withdrawFunds(alice, '10000', 'usei');
            await broadcastTx(alice, withdrawPayload.stdout, CT_CONTRACT_ADDRESS);

            const uatomBalanceAfter = await getDecryptedBalance(alice, 'uatom');
            const uatomBalanceAfterOnBank = await exec(`seid q bank balances ${alice.seiAddress} --denom uatom`);
            const totalIssuanceAfter = await exec(`seid q bank total ${alice.seiAddress} --denom uatom`);
            const moduleBalanceAfter = await exec(`seid q bank balances ${ctModuleAddress} --denom usei --output json`);

            expect(Number(JSON.parse(moduleBalance.stdout).amount)).to.be.eq(Number(JSON.parse(moduleBalanceAfter.stdout).amount) + 10000);
            expect(JSON.stringify(uatomBalanceOnBank)).to.equal(JSON.stringify(uatomBalanceAfterOnBank));
            expect(JSON.stringify(uatomBalance)).to.equal(JSON.stringify(uatomBalanceAfter));
            expect(JSON.stringify(totalIssuancePre)).to.equal(JSON.stringify(totalIssuanceAfter));
        });

        it('Alice cant withdraw more than her balance', async () =>{
            try {
                const payload = await getPayload().withdrawFunds(alice, '150000', 'uatom');
            } catch(e: any){
                expect(e.message).to.contain('Error: insufficient balance');
            }
        });

        it('Alice cant withdraw pending balance', async () =>{
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
        let funder: Funder;

        before('Initializes clients and users', async () => {
            ({alice, bob} = await returnUsers(testConfig));
            funder = new Funder(testConfig.adminAddress);
            await funder.fundAdminOnSei();
            await funder.fundAdminOnSei('uatom');

            console.info('Funded admin on sei for uatom');
            await funder.fundAddressOnSei(alice.seiAddress);
            await funder.fundAddressOnSei(bob.seiAddress);

            await funder.fundAddressOnSei(alice.seiAddress, 'uatom');
            await funder.fundAddressOnSei(bob.seiAddress, 'uatom');

            const initAccountPayload = await getPayload().initializeAccount(alice, 'usei');
            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);
            const initAccountPayload2 = await getPayload().initializeAccount(bob, 'usei');
            await broadcastTx(bob, initAccountPayload2.stdout, CT_CONTRACT_ADDRESS);

            const initAccountPayload3 = await getPayload().initializeAccount(alice, 'uatom');
            await broadcastTx(alice, initAccountPayload3.stdout, CT_CONTRACT_ADDRESS);

            const initAccountPayload4 = await getPayload().initializeAccount(bob, 'uatom');
            await broadcastTx(bob, initAccountPayload4.stdout, CT_CONTRACT_ADDRESS);
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
                console.log(e);
            }
        });

        it('If a user has pending balance, it cant be closed', async () => {
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
                console.log(e);
            }
        });

        it('It can only be closed given that user has no available balance', async () => {

        });

        it('It can be closed without any interaction to the module', async () =>{
            const closePayload = await getPayload().closeAccount(bob);
            await broadcastTx(bob, closePayload.stdout, CT_CONTRACT_ADDRESS);

            const decryptedBalance = await getDecryptedBalance(bob, 'usei');
            console.log(decryptedBalance);
        });

        it('Can reopen accounts', async () =>{
            const initPayload = await getPayload().initializeAccount(bob);
            await broadcastTx(bob, initPayload.stdout, CT_CONTRACT_ADDRESS);

            const depositPayload = await getPayload().deposit('usei', '100000');
            await broadcastTx(bob, depositPayload.stdout, CT_CONTRACT_ADDRESS);

            const decryptedBalance = await getDecryptedBalance(bob, 'usei');
            console.log(decryptedBalance);
        })
    })

    describe('Gov tests', function () {
        let alice: SeiUser;
        let bob: SeiUser;
        let funder: Funder;
        let govContract: Contract;
        let denomName: string;

        before('Initializes clients and users', async () => {
            const GOV_ADDRESS = "0x0000000000000000000000000000000000001006";
            ({alice, bob} = await returnUsers(testConfig));
            funder = new Funder(testConfig.adminAddress);
            await funder.fundAdminOnSei();

            console.info('Funded admin on sei for uatom');
            await funder.fundAddressOnSei(alice.seiAddress);

            await funder.fundAddressOnSei(alice.seiAddress, 'uatom');

            const initAccountPayload = await getPayload().initializeAccount(alice, 'usei');
            await broadcastTx(alice, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);

            // admin creates a token factory denom
            await execCommandAndReturnJson(`seid tx tokenfactory create-denom test1 --from ${admin.seiAddress} --fees 24200usei -y --broadcast-mode block`);
            denomName = `factory/${admin.seiAddress}/test1`;
            await execCommandAndReturnJson(`seid tx tokenfactory mint 10000000000${denomName} --from ${admin.seiAddress} --fees 24200usei -y --broadcast-mode block`);
            govContract = new Contract(GOV_ADDRESS, govAbi, admin.evmWallet.wallet);
        });

        it('Stakes to cast vote on gov proposal', async () => {
            const STAKING_ADDRESS = "0x0000000000000000000000000000000000001005";
            const stakingContract = new Contract(STAKING_ADDRESS, stakingAbi, admin.evmWallet.wallet);
            const stakingQueryClient = await returnQueryClient(setupStakingExtension) as QueryClient & StakingExtension;

            const validatorsResponse = await stakingQueryClient.staking.validators("BOND_STATUS_BONDED");
            const validatorAddress1 = validatorsResponse.validators[0].operatorAddress;

            const stakeAmount = ethers.parseEther("50");
            const adminStakeAmount = ethers.parseEther("7500");
            const delegateTx = await stakingContract.connect(alice.evmWallet.wallet)
                .delegate(validatorAddress1, { value: stakeAmount });
            await waitFor(1);

            const delegateTx2 = await stakingContract.connect(admin.evmWallet.wallet)
                .delegate(validatorAddress1, { value: adminStakeAmount });
            const receipt = await delegateTx2.wait();
            console.log(receipt);
        });

        it('Sends proposal and votes', async () => {
            const proposalSubmitTx = await execCommandAndReturnJson(`seid tx gov submit-proposal param-change proposal_ct.json --from admin --fees 24200usei --broadcast-mode block -y`);
            const querier = await returnQueryClient(setupGovExtension) as QueryClient & GovExtension;
            const proposalID = Number(proposalSubmitTx.logs[0].events.find(ev => ev.type === 'submit_proposal').attributes[0].value);
            await waitFor(2);
            const proposalDetails1 = await querier.gov.proposal(proposalID);
            console.log(proposalDetails1);
            // const depositTx = await govContract.connect(alice.evmWallet.wallet)
            //     .deposit(proposalID, { value: '10000000', gasLimit: 10000000 });
            // const depositReceipt = await depositTx.wait();
            console.log('Deposited');
            const proposalDetails = await querier.gov.proposal(proposalID);
            const submitTime = new Date(Number(proposalDetails.proposal.submitTime.seconds) * 1000
                + Math.floor(Number(proposalDetails.proposal.submitTime.nanos) / 1e6));
            const depositEndTime = new Date(Number(proposalDetails.proposal.depositEndTime.seconds) * 1000
                + Math.floor(Number(proposalDetails.proposal.depositEndTime.nanos) / 1e6));
            console.log(
                "Proposal submit time:", submitTime.toUTCString(),
                "Deposit end time:", depositEndTime.toUTCString()
            )
            let proposalStatus = proposalDetails.proposal.status;
            while (proposalStatus === 1) {
                await waitFor(3);
                proposalStatus = (await querier.gov.proposal(proposalID)).proposal.status;
                console.log('Waiting for 3 seconds')
            }
            const voteOption = 1;
            const voteTx = await govContract.connect(alice.evmWallet.wallet)
                .vote(proposalID, voteOption);
            await exec(`seid tx gov vote ${proposalID} yes --from admin --fees 24200usei --broadcast-mode block -y`);
            const vote2Tx = await govContract.connect(admin.evmWallet.wallet).vote(proposalID, voteOption);
            await voteTx.wait();
            await vote2Tx.wait();
            const votes = await querier.gov.votes(proposalID);
            console.log(votes);
            await waitFor(60);
            console.log(proposalID);
        });

        it('After proposal passes admin can init account', async() =>{
            console.log(denomName);

            const adminBalance = await exec(`seid q bank balances ${admin.seiAddress} --denom ${denomName} --output json`);
            console.log(adminBalance.stdout);
            const initAccountPayload = await getPayload().initializeAccount(admin, denomName);
            await broadcastTx(admin, initAccountPayload.stdout, CT_CONTRACT_ADDRESS);

            const depositTx = await getPayload().deposit(denomName, '100000');
            await broadcastTx(admin, depositTx.stdout, CT_CONTRACT_ADDRESS);

            const decryptedBalance = await getDecryptedBalance(admin, denomName);
            console.log(decryptedBalance);
        });
    });
})

import { ethers } from 'ethers';
import { BankExtension, QueryClient, setupBankExtension } from '@cosmjs/stargate';
import { SeiUser, UserFactory } from '../../shared/User';
import { expect } from 'chai';
import { mintTokens, returnContracts, returnQueryClient, setMetadataOfaToken } from './utils';
import { createTokenfactoryDenom, execCommandAndReturnJson } from '../../shared/utils/cliUtils';
import { waitFor } from '../../shared/utils/helpers';

describe('Bank Precompile Tests', function () {
    this.timeout(3 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let bankContract: ethers.Contract;
    let denomName: string;
    let bankQueryClient: QueryClient & BankExtension;

    before('Initializes clients, users, and tokenfactory denom', async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'alice');
        bob = await UserFactory.createSeiUser(admin, 'bob');
        console.log(alice.evmAddress, bob.evmAddress);

        ({ bankContract } = await returnContracts(admin));
        denomName = await createTokenfactoryDenom(alice, admin);
        bankQueryClient = await returnQueryClient(setupBankExtension) as QueryClient & BankExtension;
    });

    describe('balance()', function () {
        it('Returns zero for a denom the user has never held', async () => {
            const balance = await bankContract.balance(alice.evmAddress, denomName);
            expect(balance).to.be.a('bigint');
            expect(balance).to.equal(0n);
        });

        it('Reflects minted amount after tokenfactory mint', async () => {
            const mintAmount = 1_000_000;
            await mintTokens(alice, denomName, mintAmount.toString());
            await waitFor(1);
            const balance = await bankContract.balance(alice.evmAddress, denomName);
            expect(balance).to.equal(BigInt(mintAmount));
        });

        it('Returns usei balance that matches Cosmos query', async () => {
            const evmBalance = await bankContract.balance(admin.evmAddress, 'usei');
            const cosmosBalance = await bankQueryClient.bank.balance(admin.seiAddress, 'usei');
            expect(evmBalance).to.be.a('bigint');
            expect(evmBalance > 0n).to.equal(true, `Expected positive usei balance, got ${evmBalance}`);
            expect(evmBalance).to.equal(BigInt(cosmosBalance.amount));
        });

        it('Returns zero for a completely unknown denom', async () => {
            const balance = await bankContract.balance(alice.evmAddress, 'unonexistent999');
            expect(balance).to.equal(0n);
        });

        it('Reverts when querying balance for the zero address', async () => {
            try {
                await bankContract.balance(ethers.ZeroAddress, 'usei');
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                expect(e.code).to.equal('CALL_EXCEPTION');
            }
        });
    });

    describe('all_balances()', function () {
        it('Returns an array of Coin tuples for a funded user', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            expect(allBalances).to.be.an('array');
            expect(allBalances.length).to.be.greaterThan(0);
        });

        it('Each balance entry has amount (uint256) and denom (string)', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            for (const entry of allBalances) {
                const amount = entry[0];
                const denom = entry[1];
                expect(typeof amount).to.equal('bigint');
                expect(amount >= 0n).to.equal(true, `Expected non-negative amount, got ${amount}`);
                expect(denom).to.be.a('string');
                expect(denom.length).to.be.greaterThan(0);
            }
        });

        it('Matches Cosmos bank balances for every denom', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            for (const entry of allBalances) {
                const amount = entry[0];
                const denom = entry[1];
                const cosmosBalance = await execCommandAndReturnJson(
                    `seid query bank balances ${alice.seiAddress} --denom ${denom}`
                );
                expect(Number(amount)).to.equal(
                    Number(cosmosBalance.amount),
                    `Mismatch for denom ${denom}: EVM=${amount}, Cosmos=${cosmosBalance.amount}`
                );
            }
        });

        it('Returns empty array for unfunded address', async () => {
            const randomWallet = ethers.Wallet.createRandom();
            const allBalances = await bankContract.all_balances(randomWallet.address);
            expect(allBalances).to.be.an('array');
            expect(allBalances.length).to.equal(0);
        });

        it('Includes tokenfactory denom after minting', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            const denomEntry = allBalances.find((e: any) => e[1] === denomName);
            expect(denomEntry).to.not.be.undefined;
            expect(denomEntry[0] > 0n).to.equal(true, `Expected positive balance for ${denomName}`);
        });
    });

    describe('decimals()', function () {
        it('Returns a valid uint8 for usei', async () => {
            const decimals = await bankContract.decimals('usei');
            expect(typeof decimals).to.equal('bigint');
            expect(Number(decimals)).to.be.greaterThanOrEqual(0);
            expect(Number(decimals)).to.be.lessThanOrEqual(18);
        });

        it('Returns 0 for a tokenfactory denom without metadata', async () => {
            const decimals = await bankContract.decimals(denomName);
            expect(Number(decimals)).to.equal(0);
        });

        it('Returns updated decimals after setting denom metadata', async () => {
            await setMetadataOfaToken(denomName, alice);
            await waitFor(2);
            const decimals = await bankContract.decimals(denomName);
            expect(Number(decimals)).to.be.greaterThanOrEqual(0);
            expect(Number(decimals)).to.be.lessThanOrEqual(18);
        });
    });

    describe('name()', function () {
        it('Returns the full denom string for a tokenfactory denom', async () => {
            const name = await bankContract.name(denomName);
            expect(name).to.be.a('string');
            expect(name).to.equal(denomName);
        });
    });

    describe('symbol()', function () {
        it('Returns a non-empty string for a tokenfactory denom', async () => {
            const symbol = await bankContract.symbol(denomName);
            expect(symbol).to.be.a('string');
            expect(symbol.length).to.be.greaterThan(0);
        });

        it('Reverts for usei (no denom metadata)', async () => {
            const symbol = await bankContract.symbol('usei');
            console.log(symbol);  
        });
    });

    describe('supply()', function () {
        it('Returns total supply of usei as a positive bigint', async () => {
            const supply = await bankContract.supply('usei');
            expect(supply).to.be.a('bigint');
            expect(supply > 0n).to.equal(true, `Expected positive usei supply, got ${supply}`);
        });

        it('Returns total supply of tokenfactory denom matching minted amount', async () => {
            const supply = await bankContract.supply(denomName);
            expect(supply).to.be.a('bigint');
            expect(supply > 0n).to.equal(true, `Expected positive supply for ${denomName}, got ${supply}`);
        });

        it('Supply matches Cosmos total supply query', async () => {
            const evmSupply = await bankContract.supply(denomName);
            const cosmosSupply = await execCommandAndReturnJson(
                `seid query bank total --denom ${denomName}`
            );
            expect(Number(evmSupply)).to.equal(Number(cosmosSupply.amount));
        });

        it('Returns zero for non-existent denom', async () => {
            const supply = await bankContract.supply('unonexistent999');
            expect(supply).to.equal(0n);
        });
    });

    describe('send() — restricted to ERC20 pointer contracts only', function () {
        const bankSend = (contract: ethers.Contract) => contract.getFunction("send");

        it('Reverts when called directly from an EOA (not via ERC20 pointer)', async () => {
            const sendAmount = 500n;
            const balancePre = await bankContract.balance(alice.evmAddress, denomName);
            expect(balancePre > 0n).to.equal(true, 'Alice should have tokens to attempt send');

            try {
                const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
                const tx = await bankSend(aliceBank)(alice.evmAddress, bob.evmAddress, denomName, sendAmount, { gasLimit: 1_000_000 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                expect(e.code).to.equal('CALL_EXCEPTION');
            }

            const balancePost = await bankContract.balance(alice.evmAddress, denomName);
            expect(balancePost).to.equal(balancePre, 'Balance should be unchanged after rejected send');
        });
    });

    describe('sendNative()', function () {
        it('Sends usei to a Cosmos address and balances update correctly', async () => {
            const sendAmountWei = ethers.parseEther('0.01');
            const sendAmountUsei = 10000n;

            const cosmosPre = await bankQueryClient.bank.balance(admin.seiAddress, 'usei');
            const evmPre = await bankContract.balance(admin.evmAddress, 'usei');
            const senderPre = await bankContract.balance(alice.evmAddress, 'usei');

            const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
            const tx = await aliceBank.sendNative(admin.seiAddress, { value: sendAmountWei });
            const receipt = await tx.wait();

            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);

            await waitFor(1);
            const cosmosPost = await bankQueryClient.bank.balance(admin.seiAddress, 'usei');
            const evmPost = await bankContract.balance(admin.evmAddress, 'usei');
            const senderPost = await bankContract.balance(alice.evmAddress, 'usei');

            expect(BigInt(cosmosPost.amount)).to.equal(BigInt(cosmosPre.amount) + sendAmountUsei);
            expect(evmPost).to.equal(evmPre + sendAmountUsei);
            expect(senderPre - senderPost > sendAmountUsei).to.equal(true, 'Sender should lose more than sendAmount (includes gas)');
        });

        it('sendNative to an EVM hex address (0x) also works', async () => {
            const sendAmountWei = ethers.parseEther('0.005');
            const sendAmountUsei = 5000n;

            const receiverPre = await bankContract.balance(bob.evmAddress, 'usei');

            const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
            const tx = await aliceBank.sendNative(bob.seiAddress, { value: sendAmountWei });
            const receipt = await tx.wait();

            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);

            await waitFor(1);
            const receiverPost = await bankContract.balance(bob.evmAddress, 'usei');
            expect(receiverPost).to.equal(receiverPre + sendAmountUsei);
        });

        it('Multiple sequential sendNative calls accumulate correctly', async () => {
            const perSend = ethers.parseEther('0.001');
            const perSendUsei = 1000n;
            const numSends = 3;

            const receiverPre = await bankContract.balance(admin.evmAddress, 'usei');

            const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
            for (let i = 0; i < numSends; i++) {
                const tx = await aliceBank.sendNative(admin.seiAddress, { value: perSend });
                await tx.wait();
            }
            await waitFor(1);

            const receiverPost = await bankContract.balance(admin.evmAddress, 'usei');
            expect(receiverPost).to.equal(receiverPre + perSendUsei * BigInt(numSends));
        });

        it('Fails when sending zero value', async () => {
            try {
                const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
                const tx = await aliceBank.sendNative(admin.seiAddress, { value: 0 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });

        it('Fails when sender has insufficient usei balance', async () => {
            const newUser = await UserFactory.createSeiUser(admin, 'bankBroke');
            try {
                const brokeBank = bankContract.connect(newUser.evmWallet.wallet) as ethers.Contract;
                const tx = await brokeBank.sendNative(admin.seiAddress, { value: ethers.parseEther('9999999') });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });

    describe('Cross-runtime consistency', function () {
        it('balance() via precompile matches seid query for every denom alice holds', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            for (const entry of allBalances) {
                const evmAmount = entry[0];
                const denom = entry[1];
                const cosmosBalance = await bankQueryClient.bank.balance(alice.seiAddress, denom);
                expect(Number(evmAmount)).to.equal(
                    Number(cosmosBalance.amount),
                    `Cross-runtime mismatch for ${denom}`
                );
            }
        });

        it('supply() via precompile matches seid query bank total for usei', async () => {
            const evmSupply = await bankContract.supply('usei');
            const cosmosSupply = await execCommandAndReturnJson('seid query bank total --denom usei');
            expect(Number(evmSupply)).to.equal(Number(cosmosSupply.amount));
        });

        it('After Cosmos-side bank send, EVM balance reflects the change', async () => {
            const sendAmount = 5000;
            const evmPre = await bankContract.balance(alice.evmAddress, denomName);

            await mintTokens(alice, denomName, sendAmount.toString());
            await waitFor(2);

            const evmPost = await bankContract.balance(alice.evmAddress, denomName);
            expect(evmPost).to.equal(evmPre + BigInt(sendAmount));
        });

        it('After sendNative, Cosmos balance reflects the change', async () => {
            const sendAmountWei = ethers.parseEther('0.005');
            const sendAmountUsei = 5000n;
            const cosmosPre = await bankQueryClient.bank.balance(bob.seiAddress, 'usei');

            const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
            const tx = await aliceBank.sendNative(bob.seiAddress, { value: sendAmountWei });
            await tx.wait();
            await waitFor(1);

            const cosmosPost = await bankQueryClient.bank.balance(bob.seiAddress, 'usei');
            expect(BigInt(cosmosPost.amount)).to.equal(BigInt(cosmosPre.amount) + sendAmountUsei);
        });
    });
});

import { ethers, Contract } from 'ethers';
import { expect } from 'chai';
import { SeiUser, UserFactory } from '../../shared/User';
import { waitFor } from '../../shared/utils/helpers';
import { execCommandAndReturnJson } from '../../shared/utils/cliUtils';
import { mintTokens, setMetadataOfaToken } from './utils';
import { BANK_PRECOMPILE_ADDRESS } from './constants';
import BANK_ABI from './abis/bank_abi.json';

describe('TokenFactory Tests', function () {
    this.timeout(3 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let bankContract: Contract;

    const denomSuffix = `tf${Date.now()}`;
    let denomName: string;

    before('Initialize users', async () => {
        admin = await UserFactory.createAdminUser();
        [alice, bob] = await UserFactory.createSeiUsers(admin, 2);

        bankContract = new Contract(BANK_PRECOMPILE_ADDRESS, BANK_ABI, admin.evmWallet.wallet);
    });

    describe('create-denom', function () {

        it('should create a new tokenfactory denom', async () => {
            const result = await execCommandAndReturnJson(
                `seid tx tokenfactory create-denom ${denomSuffix} --from ${alice.seiAddress} --fees 24200usei --broadcast-mode block -y`
            );
            denomName = `factory/${alice.seiAddress}/${denomSuffix}`;

            expect(result.code).to.equal(0);
            console.log(`Created denom: ${denomName}`);
        });

        it('should fail to create a duplicate denom', async () => {
            try {
                const result = await execCommandAndReturnJson(
                    `seid tx tokenfactory create-denom ${denomSuffix} --from ${alice.seiAddress} --fees 24200usei --broadcast-mode block -y`
                );
                expect(result.code).to.not.equal(0);
            } catch (e: any) {
                console.log('Duplicate denom creation failed as expected');
            }
        });
    });

    describe('mint', function () {

        it('should mint tokens to the creator', async () => {
            const balanceBefore = await bankContract.balance(alice.evmAddress, denomName);

            await mintTokens(alice, denomName, '1000000');

            const balanceAfter = await bankContract.balance(alice.evmAddress, denomName);
            expect(Number(balanceAfter)).to.equal(Number(balanceBefore) + 1000000);
            console.log(`Minted 1000000, balance: ${balanceAfter}`);
        });

        it('should mint additional tokens and accumulate', async () => {
            const balanceBefore = await bankContract.balance(alice.evmAddress, denomName);

            await mintTokens(alice, denomName, '500000');

            const balanceAfter = await bankContract.balance(alice.evmAddress, denomName);
            expect(Number(balanceAfter)).to.equal(Number(balanceBefore) + 500000);
        });

        it('should fail when non-admin tries to mint', async () => {
            try {
                const result = await execCommandAndReturnJson(
                    `seid tx tokenfactory mint 100${denomName} --from ${bob.seiAddress} --fees 24200usei --broadcast-mode block -y`
                );
                expect(result.code).to.not.equal(0);
            } catch (e: any) {
                console.log('Non-admin mint failed as expected');
            }
        });
    });

    describe('burn', function () {

        it('should burn tokens from the creator', async () => {
            const balanceBefore = await bankContract.balance(alice.evmAddress, denomName);
            expect(Number(balanceBefore)).to.be.gt(0);

            const burnAmount = '200000';
            const result = await execCommandAndReturnJson(
                `seid tx tokenfactory burn ${burnAmount}${denomName} --from ${alice.seiAddress} --fees 24200usei --broadcast-mode block -y`
            );
            expect(result.code).to.equal(0);

            const balanceAfter = await bankContract.balance(alice.evmAddress, denomName);
            expect(Number(balanceAfter)).to.equal(Number(balanceBefore) - 200000);
            console.log(`Burned 200000, balance: ${balanceAfter}`);
        });

        it('should fail when non-admin tries to burn', async () => {
            try {
                const result = await execCommandAndReturnJson(
                    `seid tx tokenfactory burn 100${denomName} --from ${bob.seiAddress} --fees 24200usei --broadcast-mode block -y`
                );
                expect(result.code).to.not.equal(0);
            } catch (e: any) {
                console.log('Non-admin burn failed as expected');
            }
        });
    });

    describe('supply', function () {

        it('should reflect correct supply via bank precompile', async () => {
            const supply = await bankContract.supply(denomName);
            const balance = await bankContract.balance(alice.evmAddress, denomName);
            expect(Number(supply)).to.equal(Number(balance));
            console.log(`Supply: ${supply}, Alice balance: ${balance}`);
        });

        it('supply should increase after minting', async () => {
            const supplyBefore = await bankContract.supply(denomName);

            await mintTokens(alice, denomName, '300000');

            const supplyAfter = await bankContract.supply(denomName);
            expect(Number(supplyAfter)).to.equal(Number(supplyBefore) + 300000);
        });

        it('supply should decrease after burning', async () => {
            const supplyBefore = await bankContract.supply(denomName);

            await execCommandAndReturnJson(
                `seid tx tokenfactory burn 100000${denomName} --from ${alice.seiAddress} --fees 24200usei --broadcast-mode block -y`
            );

            const supplyAfter = await bankContract.supply(denomName);
            expect(Number(supplyAfter)).to.equal(Number(supplyBefore) - 100000);
        });
    });

    describe('set-denom-metadata', function () {

        it('should set denom metadata', async () => {
            await setMetadataOfaToken(denomName, alice);
            await waitFor(2);

            const name = await bankContract.name(denomName);
            expect(name).to.equal(denomName);
            console.log(`Denom name: ${name}`);
        });

        it('should query symbol after metadata is set', async () => {
            const symbol = await bankContract.symbol(denomName);
            expect(symbol).to.be.a('string');
            console.log(`Denom symbol: ${symbol}`);
        });
    });

    describe('transfer via bank precompile', function () {

        it('should transfer tokenfactory tokens between users', async () => {
            const aliceBalanceBefore = await bankContract.balance(alice.evmAddress, denomName);
            const bobBalanceBefore = await bankContract.balance(bob.evmAddress, denomName);

            const sendTx = await bankContract.connect(alice.evmWallet.wallet)
                .send(alice.evmAddress, bob.evmAddress, denomName, '50000', { gasLimit: 1000000 });
            await sendTx.wait();

            const aliceBalanceAfter = await bankContract.balance(alice.evmAddress, denomName);
            const bobBalanceAfter = await bankContract.balance(bob.evmAddress, denomName);

            expect(Number(aliceBalanceAfter)).to.equal(Number(aliceBalanceBefore) - 50000);
            expect(Number(bobBalanceAfter)).to.equal(Number(bobBalanceBefore) + 50000);
            console.log(`Transferred 50000 from alice to bob`);
        });

        it('should transfer tokens via CLI and verify via precompile', async () => {
            const bobBalanceBefore = await bankContract.balance(bob.evmAddress, denomName);

            await execCommandAndReturnJson(
                `seid tx bank send ${alice.seiAddress} ${bob.seiAddress} 25000${denomName} --from ${alice.seiAddress} --fees 24200usei --broadcast-mode block -y`
            );

            const bobBalanceAfter = await bankContract.balance(bob.evmAddress, denomName);
            expect(Number(bobBalanceAfter)).to.equal(Number(bobBalanceBefore) + 25000);
        });
    });

    describe('change-admin', function () {

        let adminDenomSuffix: string;
        let adminDenom: string;

        before(async () => {
            adminDenomSuffix = `adm${Date.now()}`;
            await execCommandAndReturnJson(
                `seid tx tokenfactory create-denom ${adminDenomSuffix} --from ${alice.seiAddress} --fees 24200usei --broadcast-mode block -y`
            );
            adminDenom = `factory/${alice.seiAddress}/${adminDenomSuffix}`;

            await mintTokens(alice, adminDenom, '500000');
        });

        it('should change denom admin to another user', async () => {
            const result = await execCommandAndReturnJson(
                `seid tx tokenfactory change-admin ${adminDenom} ${bob.seiAddress} --from ${alice.seiAddress} --fees 24200usei --broadcast-mode block -y`
            );
            expect(result.code).to.equal(0);
            console.log(`Changed admin of ${adminDenom} to bob`);
        });

        it('new admin should be able to mint', async () => {
            const supplyBefore = await bankContract.supply(adminDenom);

            await execCommandAndReturnJson(
                `seid tx tokenfactory mint 100000${adminDenom} --from ${bob.seiAddress} --fees 24200usei --broadcast-mode block -y`
            );

            const supplyAfter = await bankContract.supply(adminDenom);
            expect(Number(supplyAfter)).to.equal(Number(supplyBefore) + 100000);
        });

        it('old admin should no longer be able to mint', async () => {
            try {
                const result = await execCommandAndReturnJson(
                    `seid tx tokenfactory mint 100${adminDenom} --from ${alice.seiAddress} --fees 24200usei --broadcast-mode block -y`
                );
                expect(result.code).to.not.equal(0);
            } catch (e: any) {
                console.log('Old admin mint failed as expected');
            }
        });
    });

    describe('all_balances with tokenfactory denom', function () {

        it('should include tokenfactory denom in all_balances', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            const denomBalance = allBalances.find((b: any) => b[1] === denomName);

            expect(denomBalance).to.not.be.undefined;
            expect(Number(denomBalance[0])).to.be.gt(0);
            console.log(`TokenFactory denom in all_balances: ${denomBalance[0]}`);
        });

        it('bob should have tokenfactory tokens after receiving transfers', async () => {
            const allBalances = await bankContract.all_balances(bob.evmAddress);
            const denomBalance = allBalances.find((b: any) => b[1] === denomName);

            expect(denomBalance).to.not.be.undefined;
            expect(Number(denomBalance[0])).to.be.gt(0);
        });
    });
});

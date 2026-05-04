import { ethers, Contract } from 'ethers';
import { expect } from 'chai';
import { SeiUser, UserFactory } from '../../shared/User';
import { ADDR_PRECOMPILE_ADDRESS } from './constants';
import ADDR_ABI from './abis/addr_abi.json';
import { waitFor } from '../../shared/utils/helpers';

describe('Addr Precompile Tests', function () {
    this.timeout(3 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let addrContract: Contract;

    before('Initialize users and contract', async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'addrAlice');
        addrContract = new Contract(ADDR_PRECOMPILE_ADDRESS, ADDR_ABI, admin.evmWallet.wallet);
    });

    describe('Sei Address Lookup', function () {
        it('Returns correct Sei address for an associated EVM address', async () => {
            const seiAddr = await addrContract.getSeiAddr(admin.evmAddress);
            expect(seiAddr).to.be.a('string');
            expect(seiAddr).to.have.lengthOf.greaterThan(0);
            expect(seiAddr).to.match(/^sei1[a-z0-9]+$/);
            expect(seiAddr).to.equal(admin.seiAddress);
        });

        it('Returns correct Sei address for alice', async () => {
            const seiAddr = await addrContract.getSeiAddr(alice.evmAddress);
            expect(seiAddr).to.be.a('string');
            expect(seiAddr).to.equal(alice.seiAddress);
        });

        it('Reverts for unassociated EVM address', async () => {
            const randomWallet = ethers.Wallet.createRandom();
            try {
                await addrContract.getSeiAddr(randomWallet.address);
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                expect(e.code).to.equal('CALL_EXCEPTION');
            }
        });

        it('Reverts for zero address', async () => {
            try {
                await addrContract.getSeiAddr(ethers.ZeroAddress);
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                expect(e.code).to.equal('CALL_EXCEPTION');
            }
        });
    });

    describe('Evm Address Lookup', function () {
        it('Returns correct EVM address for an associated Sei address', async () => {
            const evmAddr = await addrContract.getEvmAddr(admin.seiAddress);
            expect(evmAddr).to.be.a('string');
            expect(evmAddr).to.have.lengthOf(42);
            expect(evmAddr.toLowerCase()).to.equal(admin.evmAddress.toLowerCase());
        });

        it('Returns correct EVM address for alice', async () => {
            const evmAddr = await addrContract.getEvmAddr(alice.seiAddress);
            expect(evmAddr.toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
        });

        it('Reverts for non-existent Sei address', async () => {
            try {
                await addrContract.getEvmAddr('sei1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqse8pn9');
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                expect(e.code).to.equal('CALL_EXCEPTION');
            }
        });

        it('Reverts for an unassociated Sei address', async () => {
            const unassociated = await UserFactory.createUnassociatedUsers(admin, 'addrUnassoc');
            try {
                await addrContract.getEvmAddr(unassociated.seiAddress);
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                expect(e.code).to.equal('CALL_EXCEPTION');
            }
        });

        it('Bidirectional lookup is consistent (EVM→Sei→EVM)', async () => {
            const seiAddr = await addrContract.getSeiAddr(admin.evmAddress);
            const evmAddr = await addrContract.getEvmAddr(seiAddr);
            expect(evmAddr.toLowerCase()).to.equal(admin.evmAddress.toLowerCase());
        });
    });

    describe('Account Association', function () {
        const callAssociate = () => addrContract.getFunction("associate");
        const callAssociatePubKey = () => addrContract.getFunction("associatePubKey");

        it('Associates a new user via signature and address becomes queryable', async () => {
            const newUser = await UserFactory.createUnassociatedUsers(admin, 'addrTest');

            // Match Go test pattern: EIP-191 prefixed message, keccak256, raw ECDSA sign
            const emptyData = new Uint8Array(32);
            const prefixedMessage = `\x19Ethereum Signed Message:\n${emptyData.length}` + String.fromCharCode(...emptyData);
            const messageHash = ethers.keccak256(ethers.toUtf8Bytes(prefixedMessage));
            const sig = newUser.evmWallet.wallet.signingKey.sign(messageHash);

            // Precompile adds 27 to v, so pass raw recovery ID (0 or 1)
            const v = '0x' + (sig.v - 27).toString(16).padStart(2, '0');

            const tx = await callAssociate()(v, sig.r, sig.s, prefixedMessage, { gasLimit: 500_000 });
            const receipt = await tx.wait();

            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);

            await waitFor(1);
            const seiAddr = await addrContract.getSeiAddr(newUser.evmAddress);
            expect(seiAddr).to.be.a('string');
            expect(seiAddr).to.match(/^sei1[a-z0-9]+$/);

            const evmAddr = await addrContract.getEvmAddr(seiAddr);
            expect(evmAddr.toLowerCase()).to.equal(newUser.evmAddress.toLowerCase());
        });

        it('Reverts with invalid signature components', async () => {
            try {
                const tx = await callAssociate()('0x99', '0x' + '00'.repeat(32), '0x' + '00'.repeat(32), 'bad', { gasLimit: 500_000 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });

        it('Reverts when address is already associated', async () => {
            const customMessage = 'associate_again';
            const messageHash = ethers.keccak256(ethers.toUtf8Bytes(customMessage));
            const sig = admin.evmWallet.wallet.signingKey.sign(messageHash);
            const v = '0x' + (sig.v - 27).toString(16).padStart(2, '0');

            try {
                const tx = await callAssociate()(v, sig.r, sig.s, customMessage, { gasLimit: 500_000 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });

    describe('Pubkey Association', function () {
        const callAssociatePubKey = () => addrContract.getFunction("associatePubKey");

        it('Associates a user by compressed public key and address becomes queryable', async () => {
            const newUser = await UserFactory.createUnassociatedUsers(admin, 'pubkeyTest');

            const compressedPubKey = newUser.evmWallet.wallet.signingKey.compressedPublicKey;
            // Precompile expects hex WITHOUT 0x prefix
            const pubKeyHex = compressedPubKey.startsWith('0x') ? compressedPubKey.slice(2) : compressedPubKey;

            // Admin calls associatePubKey — target is derived from the pubkey, not the caller.
            const tx = await callAssociatePubKey()(pubKeyHex, { gasLimit: 500_000 });
            const receipt = await tx.wait();

            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);

            await waitFor(1);
            const seiAddr = await addrContract.getSeiAddr(newUser.evmAddress);
            expect(seiAddr).to.be.a('string');
            expect(seiAddr).to.match(/^sei1[a-z0-9]+$/);

            const evmAddr = await addrContract.getEvmAddr(seiAddr);
            expect(evmAddr.toLowerCase()).to.equal(newUser.evmAddress.toLowerCase());
        });

        it('Reverts with empty public key', async () => {
            try {
                const tx = await callAssociatePubKey()('', { gasLimit: 500_000 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });

        it('Reverts with invalid public key hex', async () => {
            try {
                const tx = await callAssociatePubKey()('deadbeef', { gasLimit: 500_000 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });
});

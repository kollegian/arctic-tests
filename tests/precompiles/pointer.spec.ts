import { ethers, Contract } from 'ethers';
import { expect } from 'chai';
import { SeiUser, UserFactory } from '../../shared/User';
import { TokenDeployer } from '../../shared/Deployer';
import { POINTER_PRECOMPILE_ADDRESS, POINTERVIEW_PRECOMPILE_ADDRESS } from './constants';
import POINTER_ABI from './abis/pointer_abi.json';
import POINTERVIEW_ABI from './abis/pointerview_abi.json';
import { waitFor } from '../../shared/utils/helpers';
import { createTokenfactoryDenom } from '../../shared/utils/cliUtils';

describe('Pointer Precompile Tests', function () {
    this.timeout(5 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let pointerContract: Contract;
    let pointerViewContract: Contract;
    let deployer: TokenDeployer;

    before('Initialize users and contracts', async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'alice');
        pointerContract = new Contract(POINTER_PRECOMPILE_ADDRESS, POINTER_ABI, admin.evmWallet.wallet);
        pointerViewContract = new Contract(POINTERVIEW_PRECOMPILE_ADDRESS, POINTERVIEW_ABI, admin.evmWallet.wallet);
        deployer = new TokenDeployer(admin);
    });

    describe('addCW20Pointer()', function () {
        let cw20Address: string;

        before('Deploy a CW20 contract', async () => {
            const cw20 = await deployer.deployCw20('wasm_store/cw20_base.wasm', {
                name: 'PointerCW20',
                symbol: 'PCWT',
                decimals: 6,
                initial_balances: [{ address: admin.seiAddress, amount: '5000000' }],
                mint: { minter: admin.seiAddress },
            }, 'PointerCW20');
            cw20Address = cw20.getAddress();
            await waitFor(2);
        });

        it('Creates a pointer for a CW20 contract and returns a valid EVM address', async () => {
            const tx = await pointerContract.addCW20Pointer(cw20Address, { gasLimit: 5000000 });
            const receipt = await tx.wait();
            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);

            await waitFor(2);
            const [addr, version, exists] = await pointerViewContract.getCW20Pointer(cw20Address);
            expect(exists).to.equal(true);
            expect(addr).to.not.equal(ethers.ZeroAddress);
            expect(addr).to.match(/^0x[0-9a-fA-F]{40}$/);
        });

        it('Adding pointer for already-pointed CW20 does not revert and keeps the same address', async () => {
            const [addrBefore] = await pointerViewContract.getCW20Pointer(cw20Address);

            const tx = await pointerContract.addCW20Pointer(cw20Address, { gasLimit: 5000000 });
            const receipt = await tx.wait();
            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);

            await waitFor(2);
            const [addrAfter, , exists] = await pointerViewContract.getCW20Pointer(cw20Address);
            expect(exists).to.equal(true);
            expect(addrAfter).to.equal(addrBefore);
        });

        it('Reverts for invalid CW20 address', async () => {
            try {
                const tx = await pointerContract.addCW20Pointer('sei1invalidaddr', { gasLimit: 5000000 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });

    describe('addCW721Pointer()', function () {
        let cw721Address: string;

        before('Deploy a CW721 contract', async () => {
            const cw721 = await deployer.deployCw721('wasm_store/cw2981_royalties.wasm', {
                name: 'PointerNFT',
                symbol: 'PNFT',
                minter: admin.seiAddress,
            }, 'PointerNFT');
            cw721Address = cw721.getAddress();
            await waitFor(2);
        });

        it('Creates a pointer for a CW721 contract and returns a valid EVM address', async () => {
            const tx = await pointerContract.addCW721Pointer(cw721Address, { gasLimit: 5000000 });
            const receipt = await tx.wait();
            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);

            await waitFor(2);
            const [addr, version, exists] = await pointerViewContract.getCW721Pointer(cw721Address);
            expect(exists).to.equal(true);
            expect(addr).to.not.equal(ethers.ZeroAddress);
            expect(addr).to.match(/^0x[0-9a-fA-F]{40}$/);
        });

        it('Reverts for non-existent CW721 address', async () => {
            try {
                const tx = await pointerContract.addCW721Pointer('sei1nonexistent', { gasLimit: 5000000 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });

    describe('addNativePointer()', function () {
        let denomName: string;

        before('Create a tokenfactory denom', async () => {
            denomName = await createTokenfactoryDenom(alice, admin);
            await waitFor(1);
        });

        it('Creates a pointer for a native denom and returns a valid EVM address', async () => {
            const tx = await pointerContract.addNativePointer(denomName, { gasLimit: 5000000 });
            const receipt = await tx.wait();
            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);

            await waitFor(2);
            const [addr, version, exists] = await pointerViewContract.getNativePointer(denomName);
            expect(exists).to.equal(true);
            expect(addr).to.not.equal(ethers.ZeroAddress);
            expect(addr).to.match(/^0x[0-9a-fA-F]{40}$/);
        });

        it('Adding pointer for already-pointed denom does not revert', async () => {
            const tx = await pointerContract.addNativePointer(denomName, { gasLimit: 5000000 });
            const receipt = await tx.wait();
            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);
        });

        it('Reverts for empty denom string', async () => {
            try {
                const tx = await pointerContract.addNativePointer('', { gasLimit: 5000000 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });
});

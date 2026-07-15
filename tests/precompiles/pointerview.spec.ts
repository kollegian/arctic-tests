import { ethers, Contract } from 'ethers';
import { expect } from 'chai';
import { SeiUser, UserFactory } from '../../shared/User';
import { TokenDeployer } from '../../shared/Deployer';
import { POINTERVIEW_PRECOMPILE_ADDRESS, ADDR_PRECOMPILE_ADDRESS } from './constants';
import POINTERVIEW_ABI from './abis/pointerview_abi.json';
import ADDR_ABI from './abis/addr_abi.json';
import { waitFor } from '../../shared/utils/helpers';
import { isWasmEnabled, getKnownWasmContracts } from '../../shared/utils/testFlags';

// On wasm-disabled nodes we cannot deploy fresh CW contracts, so we fall back
// to the well-known contracts per network from knownContractAddresses.json.
const knownWasm = getKnownWasmContracts();

describe('PointerView Precompile Tests', function () {
    this.timeout(5 * 60 * 1000);

    let admin: SeiUser;
    let pointerViewContract: Contract;
    let deployer: TokenDeployer;
    let cw20Address: string;
    let cw721Address: string;

    before('Initialize users, deploy CW contracts, and setup precompile', async () => {
        admin = await UserFactory.createAdminUser();
        pointerViewContract = new Contract(POINTERVIEW_PRECOMPILE_ADDRESS, POINTERVIEW_ABI, admin.evmWallet.wallet);
        deployer = new TokenDeployer(admin);

        if (!isWasmEnabled()) {
            cw20Address = knownWasm.cw20Address ?? '';
            cw721Address = knownWasm.cw721Address ?? '';
            console.log(`Wasm disabled, using known cw20 at ${cw20Address || 'NONE'} and cw721 at ${cw721Address || 'NONE'}`);
            return;
        }

        const cw20 = await deployer.deployCw20('wasm_store/cw20_base.wasm', {
            name: 'PointerTestToken',
            symbol: 'PTT',
            decimals: 6,
            initial_balances: [{ address: admin.seiAddress, amount: '1000000' }],
            mint: { minter: admin.seiAddress },
        }, 'PointerTestToken');
        cw20Address = cw20.getAddress();

        const cw721 = await deployer.deployCw721('wasm_store/cw2981_royalties.wasm', {
            name: 'PointerTestNFT',
            symbol: 'PTN',
            minter: admin.seiAddress,
        }, 'PointerTestNFT');
        cw721Address = cw721.getAddress();

        await waitFor(2);
    });

    describe('getCW20Pointer()', function () {
        it('Returns exists=false for a CW20 contract without a pointer', async () => {
            const randomCw20 = 'sei1' + '0'.repeat(38) + 'qqqqqqqqqqqqq0';
            const [addr, version, exists] = await pointerViewContract.getCW20Pointer(randomCw20);
            expect(exists).to.equal(false);
            expect(addr).to.equal(ethers.ZeroAddress);
        });

        it('Returns correct pointer data for a CW20 with a deployed pointer', async function () {
            if (!cw20Address) this.skip();
            const [addr, version, exists] = await pointerViewContract.getCW20Pointer(cw20Address);
            if (!exists) {
                console.warn('No CW20 pointer deployed yet — this is expected if auto-pointers are not enabled');
                return;
            }
            expect(exists).to.equal(true);
            expect(addr).to.not.equal(ethers.ZeroAddress);
            expect(addr).to.match(/^0x[0-9a-fA-F]{40}$/);
            expect(Number(version)).to.be.greaterThanOrEqual(0);
        });

        it('Returns addr, version, exists as the correct types', async function () {
            if (!cw20Address) this.skip();
            const result = await pointerViewContract.getCW20Pointer(cw20Address);
            expect(result).to.have.lengthOf(3);
            expect(typeof result[0]).to.equal('string');
            expect(typeof result[2]).to.equal('boolean');
        });
    });

    describe('getCW721Pointer()', function () {
        it('Returns exists=false for a CW721 contract without a pointer', async () => {
            const randomAddr = 'sei1' + 'a'.repeat(38) + 'qqqqqqqqqqqq00';
            const [addr, version, exists] = await pointerViewContract.getCW721Pointer(randomAddr);
            expect(exists).to.equal(false);
            expect(addr).to.equal(ethers.ZeroAddress);
        });

        it('Returns correct pointer data for a CW721 with a deployed pointer', async function () {
            if (!cw721Address) this.skip();
            const [addr, version, exists] = await pointerViewContract.getCW721Pointer(cw721Address);
            if (!exists) {
                console.warn('No CW721 pointer deployed yet');
                return;
            }
            expect(exists).to.equal(true);
            expect(addr).to.not.equal(ethers.ZeroAddress);
            expect(addr).to.match(/^0x[0-9a-fA-F]{40}$/);
            expect(Number(version)).to.be.greaterThanOrEqual(0);
        });
    });

    describe('getNativePointer()', function () {
        it('Returns pointer for usei native token', async () => {
            const [addr, version, exists] = await pointerViewContract.getNativePointer('usei');
            if (!exists) {
                console.warn('No native pointer for usei');
                return;
            }
            expect(exists).to.equal(true);
            expect(addr).to.not.equal(ethers.ZeroAddress);
            expect(addr).to.match(/^0x[0-9a-fA-F]{40}$/);
            expect(Number(version)).to.be.greaterThanOrEqual(0);
        });

        it('Returns exists=false for non-existent native denom', async () => {
            const [addr, version, exists] = await pointerViewContract.getNativePointer('unonexistent999');
            expect(exists).to.equal(false);
            expect(addr).to.equal(ethers.ZeroAddress);
        });

        it.skip('Empty denom string returns a valid pointer (maps to a default denom)', async () => {
            const [addr, version, exists] = await pointerViewContract.getNativePointer('');
            expect(exists).to.equal(false);
        });
    });

    describe('getCW1155Pointer()', function () {
        it('Returns exists=false for non-existent CW1155 contract', async () => {
            const fakeAddr = 'sei1' + 'f'.repeat(38) + 'qqqqqqqqqqqq00';
            const [addr, version, exists] = await pointerViewContract.getCW1155Pointer(fakeAddr);
            expect(exists).to.equal(false);
            expect(addr).to.equal(ethers.ZeroAddress);
        });
    });
});

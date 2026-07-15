import {SeiUser, UserFactory} from "../../shared/User";
import {Cw20Token, Cw721Token, Erc20Token, Erc721Token} from "../../shared/Token";
import {getExistingWasmConfig, getKnownWasmContracts} from "../../shared/utils/testFlags";
import {expect} from "chai";
import axios from "axios";
import util from "node:util";
import fs from "fs";
const exec = util.promisify(require('node:child_process').exec);

/**
 * Verifies that PREVIOUSLY deployed wasm contracts (cw20/cw721 deployed by the
 * admin user on an earlier run) and their EVM pointers still work. Runs no
 * store/instantiate transactions, so it is safe on nodes where wasm deployment
 * is disabled (e.g. testnet).
 *
 * Contract addresses are resolved in this order:
 *   1. config/testConfig.json -> existingWasm.cw20Address / cw721Address
 *   2. knownContractAddresses.json at the repo root (per network, selected via
 *      the `network` key in testConfig.json)
 *   3. tests/tokens/contractAddresses.json (left over from a previous full run)
 *   4. Auto-discovery: walk the wasm code ids uploaded by the admin (newest
 *      first) and probe their contracts for the cw20/cw721 query interface.
 *
 * Run with: npm run test:wasm-existing
 */

async function queryPointer(pointerType: 'CW20' | 'CW721', contractAddress: string):
    Promise<{ pointer: string, version: number, exists: boolean }> {
    const {stdout} = await exec(`seid q evm pointer ${pointerType} ${contractAddress} --output json`);
    return JSON.parse(stdout);
}

async function discoverContractsByCreator(admin: SeiUser): Promise<{ cw20?: string, cw721?: string }> {
    // Sei's wasmd does not implement /contracts/creator/{address}, so walk the
    // uploaded code ids (newest first) and inspect contracts of the admin's codes.
    const restBase = admin.restEndpoint.replace(/\/$/, '');
    const maxCodesToScan = 50;
    const codesResponse = await axios.get(`${restBase}/cosmwasm/wasm/v1/code`, {
        params: {'pagination.limit': maxCodesToScan.toString(), 'pagination.reverse': 'true'},
    });
    const adminCodes: { code_id: string }[] = (codesResponse.data.code_infos ?? [])
        .filter((code: { creator: string }) => code.creator === admin.seiAddress);
    console.log(`Scanning ${adminCodes.length} recent code ids uploaded by admin ${admin.seiAddress}`);

    const found: { cw20?: string, cw721?: string } = {};
    for (const code of adminCodes) {
        if (found.cw20 && found.cw721) break;
        const contractsResponse = await axios.get(
            `${restBase}/cosmwasm/wasm/v1/code/${code.code_id}/contracts`,
            {params: {'pagination.limit': '1'}},
        );
        const address: string | undefined = (contractsResponse.data.contracts ?? [])[0];
        if (!address) continue;
        if (!found.cw20) {
            try {
                await admin.seiWallet.cosmWasmSigningClient.queryContractSmart(address, {token_info: {}});
                found.cw20 = address;
                continue;
            } catch { /* not a cw20 */ }
        }
        if (!found.cw721) {
            try {
                await admin.seiWallet.cosmWasmSigningClient.queryContractSmart(address, {num_tokens: {}});
                found.cw721 = address;
            } catch { /* not a cw721 */ }
        }
    }
    return found;
}

async function resolveExistingAddresses(admin: SeiUser): Promise<{ cw20Address?: string, cw721Address?: string }> {
    const configured = getExistingWasmConfig();
    let cw20Address = configured.cw20Address || undefined;
    let cw721Address = configured.cw721Address || undefined;
    if (cw20Address && cw721Address) return {cw20Address, cw721Address};

    const known = getKnownWasmContracts();
    cw20Address = cw20Address || known.cw20Address;
    cw721Address = cw721Address || known.cw721Address;
    if (cw20Address && cw721Address) return {cw20Address, cw721Address};

    try {
        const stored = JSON.parse(fs.readFileSync('./tests/tokens/contractAddresses.json', 'utf8'));
        cw20Address = cw20Address || stored.cw20Address;
        cw721Address = cw721Address || stored.cw721Address;
    } catch { /* file missing or empty, keep going */ }
    if (cw20Address && cw721Address) return {cw20Address, cw721Address};

    try {
        const discovered = await discoverContractsByCreator(admin);
        cw20Address = cw20Address || discovered.cw20;
        cw721Address = cw721Address || discovered.cw721;
    } catch (e: any) {
        console.warn(`Contract auto-discovery failed: ${e.message}`);
    }
    return {cw20Address, cw721Address};
}

describe('Existing wasm contracts and pointers', function () {
    this.timeout(5 * 60 * 1000);
    let admin: SeiUser;
    let cw20Address: string | undefined;
    let cw721Address: string | undefined;

    before('Initialize admin and resolve existing contract addresses', async () => {
        admin = await UserFactory.createAdminUser();
        ({cw20Address, cw721Address} = await resolveExistingAddresses(admin));
        console.log(`Using existing cw20: ${cw20Address ?? 'NOT FOUND'}, cw721: ${cw721Address ?? 'NOT FOUND'}`);
        if (!cw20Address && !cw721Address) {
            throw new Error(
                'No existing wasm contracts found. Set existingWasm.cw20Address / cw721Address in config/testConfig.json');
        }
    });

    describe('CW20 queries, executes and pointer', function () {
        let cw20Contract: Cw20Token;
        let erc20Pointer: Erc20Token;
        let tokenInfo: { name: string, symbol: string, decimals: number, total_supply: string };

        before(function () {
            if (!cw20Address) this.skip();
            cw20Contract = new Cw20Token(admin, cw20Address!);
        });

        it('Smart queries on the existing cw20 contract work', async () => {
            tokenInfo = await admin.seiWallet.cosmWasmSigningClient
                .queryContractSmart(cw20Address!, {token_info: {}});
            console.log('cw20 token_info:', tokenInfo);
            expect(tokenInfo.name).to.be.a('string').and.not.be.empty;
            expect(tokenInfo.symbol).to.be.a('string').and.not.be.empty;
            expect(tokenInfo.decimals).to.be.a('number');
            expect(Number(tokenInfo.total_supply)).to.be.greaterThan(0);
        });

        it('Balance query on the existing cw20 contract works', async () => {
            const balance = await cw20Contract.balanceOf(admin.seiAddress);
            console.log(`Admin cw20 balance: ${balance}`);
            expect(Number(balance)).to.be.a('number').and.not.be.NaN;
        });

        it('Wasm execute on the existing cw20 contract works (self transfer)', async () => {
            const preBalance = await cw20Contract.balanceOf(admin.seiAddress);
            expect(Number(preBalance), 'admin needs a cw20 balance to test transfers').to.be.greaterThan(0);
            cw20Contract.setSigner(admin);
            const tx = await cw20Contract.transfer(admin.seiAddress, '1');
            expect(tx.transactionHash).to.be.a('string').and.not.be.empty;
            const postBalance = await cw20Contract.balanceOf(admin.seiAddress);
            expect(Number(postBalance)).to.equal(Number(preBalance));
        });

        it('The cw20 pointer is still registered', async () => {
            const pointerInfo = await queryPointer('CW20', cw20Address!);
            console.log('cw20 pointer:', pointerInfo);
            expect(pointerInfo.exists, `No CW20 pointer registered for ${cw20Address}`).to.be.true;
            expect(pointerInfo.pointer).to.match(/^0x[0-9a-fA-F]{40}$/);
            erc20Pointer = new Erc20Token(admin, pointerInfo.pointer);
        });

        it('Pointer views match the cw20 state', async () => {
            expect(await erc20Pointer.name()).to.equal(tokenInfo.name);
            expect(await erc20Pointer.symbol()).to.equal(tokenInfo.symbol);
            expect(Number(await erc20Pointer.decimals())).to.equal(tokenInfo.decimals);
            expect((await erc20Pointer.totalSupply()).toString()).to.equal(tokenInfo.total_supply);
            const evmBalance = await erc20Pointer.balanceOf(admin.evmAddress);
            const cosmosBalance = await cw20Contract.balanceOf(admin.seiAddress);
            expect(evmBalance.toString()).to.equal(cosmosBalance);
        });

        it('A transfer through the pointer executes the wasm contract from the evm side', async () => {
            const preBalance = await cw20Contract.balanceOf(admin.seiAddress);
            const tx = await erc20Pointer.transfer(admin.evmAddress, '1');
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);
            const postBalance = await cw20Contract.balanceOf(admin.seiAddress);
            expect(Number(postBalance)).to.equal(Number(preBalance));
        });
    });

    describe('CW721 queries and pointer', function () {
        let cw721Contract: Cw721Token;
        let erc721Pointer: Erc721Token;
        let name: string;
        let symbol: string;
        let sampleTokenId: string | undefined;

        before(function () {
            if (!cw721Address) this.skip();
            cw721Contract = new Cw721Token(admin, cw721Address!);
        });

        it('Smart queries on the existing cw721 contract work', async () => {
            const contractInfo = await admin.seiWallet.cosmWasmSigningClient
                .queryContractSmart(cw721Address!, {contract_info: {}});
            console.log('cw721 contract_info:', contractInfo);
            ({name, symbol} = contractInfo);
            expect(name).to.be.a('string').and.not.be.empty;
            expect(symbol).to.be.a('string').and.not.be.empty;
        });

        it('Existing cw721 tokens can be queried', async () => {
            const totalSupply = await cw721Contract.getTotalSupply();
            console.log(`cw721 num_tokens: ${totalSupply}`);
            expect(totalSupply).to.be.greaterThan(0);
            const {tokens} = await admin.seiWallet.cosmWasmSigningClient
                .queryContractSmart(cw721Address!, {all_tokens: {limit: 1}});
            expect(tokens).to.have.lengthOf(1);
            sampleTokenId = tokens[0];
            const owner = await cw721Contract.ownerOf(sampleTokenId!);
            console.log(`cw721 token ${sampleTokenId} is owned by ${owner}`);
            expect(owner).to.match(/^sei1/);
        });

        it('The cw721 pointer is still registered', async () => {
            const pointerInfo = await queryPointer('CW721', cw721Address!);
            console.log('cw721 pointer:', pointerInfo);
            expect(pointerInfo.exists, `No CW721 pointer registered for ${cw721Address}`).to.be.true;
            expect(pointerInfo.pointer).to.match(/^0x[0-9a-fA-F]{40}$/);
            erc721Pointer = new Erc721Token(admin, pointerInfo.pointer);
        });

        it('Pointer views match the cw721 state', async function () {
            expect(await erc721Pointer.name()).to.equal(name);
            expect(await erc721Pointer.symbol()).to.equal(symbol);
            // The erc721 pointer only accepts numeric token ids
            if (sampleTokenId === undefined || !/^\d+$/.test(sampleTokenId)) {
                console.log(`Sampled token id '${sampleTokenId}' is not numeric, skipping ownerOf check via pointer`);
                this.skip();
            }
            const evmOwner = await erc721Pointer.ownerOf(sampleTokenId!);
            console.log(`Pointer ownerOf(${sampleTokenId}) = ${evmOwner}`);
            expect(evmOwner).to.match(/^0x[0-9a-fA-F]{40}$/);
        });
    });
});

import fs from 'fs';
import path from 'path';
import {ethers} from 'ethers';
import {SeiUser, UserFactory} from '../shared/User';
import {TokenDeployer} from '../shared/Deployer';
import {waitFor} from '../shared/utils/helpers';

const REPO_ROOT = path.resolve(__dirname, '..');
const TOKENS_JSON = path.join(REPO_ROOT, 'tests/tokens/contractAddresses.json');
const RPC_JSON = path.join(REPO_ROOT, 'tests/rpc_node_tests/contractAddresses.json');
const MNEMONICS_JSON = path.join(REPO_ROOT, 'config/mnemonics.json');

// Highest index any consumer reads is users[9] (eth_getBlockByNumber). Specs
// requesting fewer get the full pool back via createSeiUsers' record path.
const USER_POOL_SIZE = 10;

export interface DeployConfig {
    evmRpcEndpoint: string;
}

// Runs in the harness wrapper, not via mochaGlobalSetup: mocha's loadFilesAsync
// freezes every spec's top-level JSON import before any setup hook fires.
export async function deployFixtures(config: DeployConfig) {
    console.log('[deploy-fixtures] resetting mnemonics + contract address files');
    fs.writeFileSync(MNEMONICS_JSON, '[]');
    fs.writeFileSync(TOKENS_JSON, '{}');
    fs.writeFileSync(RPC_JSON, '{}');

    const admin = await UserFactory.createAdminUser();
    const users: SeiUser[] = await UserFactory.createSeiUsers(admin, USER_POOL_SIZE, true);
    console.log(`[deploy-fixtures] funded ${users.length} users`);

    const deployer = new TokenDeployer(admin);

    const erc20 = await deployer.deployErc20();
    await erc20.mintToUsers(users);
    await waitFor(2);

    const cwPointerAddress = await erc20.deployPointer(config.evmRpcEndpoint);

    const initialBalances = users.map(user => ({address: user.seiAddress, amount: '1000000000'}));
    const baseCw20 = await deployer.deployCw20('wasm_store/cw20_base.wasm', {
        name: 'myCwSolo',
        symbol: 'mycwSolo',
        decimals: 6,
        initial_balances: initialBalances,
        mint: {minter: admin.seiAddress},
    }, 'myCwSolo');
    await baseCw20.deployPointer(config.evmRpcEndpoint);
    // 1s raced the indexer write on cold runners.
    await waitFor(2);
    const ercPointerAddress = await baseCw20.queryPointerAddress();

    await (await erc20.contract.mint(admin.evmAddress, ethers.parseEther('100000'))).wait();
    await baseCw20.mint(admin.seiAddress, '100000000000');

    const cw721 = await deployer.deployCw721('wasm_store/cw2981_royalties.wasm', {
        name: 'cw721',
        symbol: 'mycw',
        minter: admin.seiAddress,
    }, 'mycw');
    const nftIds = users.map((_, i) => i.toString());
    await cw721.mintMultiple(nftIds, users.map(user => user.seiAddress));

    const erc721 = await deployer.deployErc721('TestNFT', 'TNFT', 'https://example.com/');
    for (let i = 0; i < users.length; i++) {
        await erc721.safeMint(users[i].evmAddress, i.toString());
    }

    const debugContract = await deployer.deployDebugContract();

    fs.writeFileSync(TOKENS_JSON, JSON.stringify({
        cw20Address: baseCw20.getAddress(),
        cw721Address: cw721.getAddress(),
        erc20Address: erc20.getAddress(),
        erc721Address: erc721.getAddress(),
    }, null, 2));

    // ercPointerOnCosmos: literal preserved from prior setup; no consumer reads it.
    fs.writeFileSync(RPC_JSON, JSON.stringify({
        erc20: erc20.getAddress(),
        cw20: baseCw20.getAddress(),
        ercPointerOnCosmos: 'cwPointerAddress',
        cwPointerOnEvm: ercPointerAddress,
        debugAddress: await debugContract.getAddress(),
    }));

    console.log('[deploy-fixtures] complete', {
        users: users.length,
        cwPointerAddress,
        ercPointerOnEvm: ercPointerAddress,
    });
}

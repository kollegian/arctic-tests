import fs from 'fs';
import path from 'path';
import {ethers} from 'ethers';
import {SeiUser, UserFactory} from '../shared/User';
import {TokenDeployer} from '../shared/Deployer';
import {waitFor} from '../shared/utils/helpers';
import {getTestConfig} from '../shared/testConfig';
import {warmupChain} from '../shared/warmup';

const REPO_ROOT = path.resolve(__dirname, '..');
const TOKENS_JSON = path.join(REPO_ROOT, 'tests/tokens/contractAddresses.json');
const RPC_JSON = path.join(REPO_ROOT, 'tests/rpc_node_tests/contractAddresses.json');
const MNEMONICS_JSON = path.join(REPO_ROOT, 'config/mnemonics.json');

// Highest index any consumer reads is users[9] (eth_getBlockByNumber). Specs
// requesting fewer get the full pool back via createSeiUsers' record path.
const USER_POOL_SIZE = 10;

// Pin a generous gas limit; eth_estimateGas under-counts on fresh chain.
const FIXTURE_GAS_LIMIT = 500_000n;
// Per-tx ceilings (broadcast + inclusion). Total deploy budget is bounded by
// the parent runner; these are the per-iteration fail-fast knobs.
const SAFE_MINT_BROADCAST_TIMEOUT_MS = 15_000;
const SAFE_MINT_INCLUSION_TIMEOUT_MS = 20_000;
const RECEIPT_POLL_INTERVAL_MS = 500;
const RECEIPT_POLL_TIMEOUT_MS = 3_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([p, timeout]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    });
}

// Manual receipt poll on a fresh provider. ethers' tx.wait() reuses the
// signer's provider — a wedged keep-alive socket from the broadcast call
// will deadlock the wait too. One fresh GET per poll sidesteps that.
async function pollReceipt(
    provider: ethers.JsonRpcProvider,
    hash: string,
    timeoutMs: number,
    label: string,
): Promise<ethers.TransactionReceipt> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let r: ethers.TransactionReceipt | null = null;
        try {
            // Per-poll timeout so a wedged socket can't deadlock past `deadline`.
            r = await withTimeout(
                provider.getTransactionReceipt(hash),
                RECEIPT_POLL_TIMEOUT_MS,
                `${label} receipt-poll`,
            );
        } catch (err: any) {
            // Per-poll error (timeout or transient RPC); retry until deadline.
            console.warn(`[deploy-fixtures] ${label} receipt-poll retry: ${err?.message ?? err}`);
        }
        if (r) {
            if (r.status === 0) throw new Error(`${label} reverted at block ${r.blockNumber}`);
            return r;
        }
        await new Promise(res => setTimeout(res, RECEIPT_POLL_INTERVAL_MS));
    }
    throw new Error(`${label} not included within ${timeoutMs}ms (hash=${hash})`);
}

async function deployFixtures() {
    console.log('[deploy-fixtures] resetting mnemonics + contract address files');
    // git prunes empty dirs — config/ may not exist in the image.
    fs.mkdirSync(path.dirname(MNEMONICS_JSON), {recursive: true});
    fs.writeFileSync(MNEMONICS_JSON, '[]');
    fs.writeFileSync(TOKENS_JSON, '{}');
    fs.writeFileSync(RPC_JSON, '{}');

    const cfg = getTestConfig();
    const admin = await UserFactory.createAdminUser();
    await warmupChain(admin, process.env.SEI_CHAIN_ID ?? '');
    await waitFor(2);  // let the indexer settle before the next wasm broadcast

    const users: SeiUser[] = await UserFactory.createSeiUsers(admin, USER_POOL_SIZE, true);
    console.log(`[deploy-fixtures] funded ${users.length} users`);

    const deployer = new TokenDeployer(admin);

    const erc20 = await deployer.deployErc20();
    await erc20.mintToUsers(users, '100', {gasLimit: FIXTURE_GAS_LIMIT});
    await waitFor(2);

    const cwPointerAddress = await erc20.deployPointer(cfg.evmRpcEndpoint);

    const initialBalances = users.map(user => ({address: user.seiAddress, amount: '1000000000'}));
    const baseCw20 = await deployer.deployCw20('wasm_store/cw20_base.wasm', {
        name: 'myCwSolo',
        symbol: 'mycwSolo',
        decimals: 6,
        initial_balances: initialBalances,
        mint: {minter: admin.seiAddress},
    }, 'myCwSolo');
    await baseCw20.deployPointer(cfg.evmRpcEndpoint);
    // 1s raced the indexer write on cold runners.
    await waitFor(2);
    const ercPointerAddress = await baseCw20.queryPointerAddress();

    await (await erc20.contract.mint(admin.evmAddress, ethers.parseEther('100000'), {gasLimit: FIXTURE_GAS_LIMIT})).wait();
    await baseCw20.mint(admin.seiAddress, '100000000000');

    const cw721 = await deployer.deployCw721('wasm_store/cw2981_royalties.wasm', {
        name: 'cw721',
        symbol: 'mycw',
        minter: admin.seiAddress,
    }, 'mycw');
    const nftIds = users.map((_, i) => i.toString());
    await cw721.mintMultiple(nftIds, users.map(user => user.seiAddress));

    const erc721 = await deployer.deployErc721('TestNFT', 'TNFT', 'https://example.com/');
    // Sequential mints with a fresh provider per iteration so no keep-alive
    // socket survives across mints.
    for (let i = 0; i < users.length; i++) {
        console.log(`[deploy-fixtures] safeMint(${i}) -> ${users[i].evmAddress}`);
        const provider = new ethers.JsonRpcProvider(cfg.evmRpcEndpoint);
        try {
            const signer = admin.evmWallet.wallet.connect(provider);
            const tx = await withTimeout(
                erc721.contract.connect(signer).safeMint(users[i].evmAddress, i.toString(), {gasLimit: FIXTURE_GAS_LIMIT}),
                SAFE_MINT_BROADCAST_TIMEOUT_MS,
                `safeMint(${i}) broadcast`,
            );
            await pollReceipt(provider, tx.hash, SAFE_MINT_INCLUSION_TIMEOUT_MS, `safeMint(${i})`);
        } finally {
            provider.destroy?.();
        }
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

deployFixtures().catch((err: any) => {
    process.stderr.write(`[deploy-fixtures] FAILED: ${err?.stack ?? err}\n`);
    process.exit(1);
});

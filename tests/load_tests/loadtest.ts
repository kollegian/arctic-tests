import { ethers } from "ethers";
import {SeiUser, UserFactory} from "../../shared/User";
import { TokenDeployer } from "../../shared/Deployer";
import { UsersPool } from "./UsersPool";
import { NodeRotator } from "./NodeRotator";
import { TxFormer } from "./TxFormer";
import { MonitorClient } from "./monitorClient";
import { NonceManager } from "./NonceManager";
import { SequenceManager } from "./sequenceManager";
import { CONFIG } from "./config";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import pLimit from "p-limit";

async function main() {
    const admin = await UserFactory.createAdminUser();
    await UserFactory.fundAdminOnSei();

    const rpcProvider = new ethers.JsonRpcProvider(admin.evmRpcEndpoint);
    const nonceMgr    = new NonceManager(rpcProvider);
    const seqMgr      = new SequenceManager(admin.seiWallet.signingClient);

    const deployer = new TokenDeployer(admin);
    const erc20    = await deployer.deployErc20();
    const usersPool = new UsersPool();
    await usersPool.init(admin);
    await usersPool.fundAll(erc20);

    const allUsers    = usersPool.all();
    const evmUsers    = allUsers.slice(0, CONFIG.EVM_USERS);
    const cosmosUsers = allUsers.slice(CONFIG.EVM_USERS);

    const baseCw20 = await deployer.deployCw20(
        "wasm_store/cw20_base.wasm",
        {
            name: "myCwSolo",
            symbol: "mycwSolo",
            decimals: 6,
            initial_balances: cosmosUsers.map(u => ({
                address: u.seiAddress,
                amount : "1000000000",
            })),
            mint: { minter: admin.seiAddress },
        },
        "myCwSolo"
    );

    const nodeRotator = new NodeRotator();
    const monitor     = new MonitorClient(
        new (require("../../shared/RpcClient").EvmRpcClient)(
            admin.evmRpcEndpoint,
            admin.evmWallet.signingClient
        ),
        admin.seiWallet.signingClient
    );
    const latencyResults = monitor.queue;


    const providerForUser = new Map<string, ethers.JsonRpcProvider>();
    function getProviderFor(user: SeiUser) {
        if (!providerForUser.has(user.seiAddress)) {
            providerForUser.set(user.seiAddress, nodeRotator.pick());
        }
        return providerForUser.get(user.seiAddress)!;
    }

    async function safeSend<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
        try {
            return await fn();
        } catch (e: any) {
            if (retries && /(nonce|sequence)/i.test(e?.error?.message ?? e.message)) {
                await new Promise(r => setTimeout(r, 300));
                return safeSend(fn, retries - 1);
            }
            throw e;
        }
    }

    const MAX_WAIT_MS = 30000;
    function waitWithTimeout(p: Promise<void>): Promise<void> {
        return Promise.race([
            p,
            new Promise<void>((_, rej) =>
                setTimeout(() => rej(new Error("wait‑timeout")), MAX_WAIT_MS))
        ]);
    }

    let successCosmos = 0;
    let successEvm    = 0;
    let failCosmos    = 0;
    let failEvm       = 0;
    const limit  = pLimit(CONFIG.MAX_CONCURRENCY);
    const tasks: Promise<void>[] = [];

    for (let n = 0; n < CONFIG.TOTAL_TXS; n++) {
        const evmUser = evmUsers[n % CONFIG.EVM_USERS];
        const cosUser = cosmosUsers[n % CONFIG.COSMOS_USERS];
        const provider = getProviderFor(evmUser);

        tasks.push(limit(async () => {
            try {
                const sendStart   = Date.now();
                const hash = await safeSend(() => TxFormer.broadcastEvmTx(
                    erc20, evmUser, admin, ethers.parseEther("0.01"), provider, nonceMgr));
                await waitWithTimeout(monitor.waitEvm(hash, Date.now(), Date.now() - sendStart));
                successEvm++;
            } catch (e) {
                failEvm++;
                console.error("EVM task failed:", e);
            }
        }));

        tasks.push(limit(async () => {
            try {
                const sendStart = Date.now();
                const raw = await TxFormer.signCosmosTransfer(cosUser, admin, baseCw20, seqMgr);
                const hash = await safeSend(() => baseCw20.broadcastTx(cosUser, raw));
                await waitWithTimeout(monitor.waitCosmos(hash, Date.now(), Date.now() - sendStart));
                successCosmos++;
            } catch (e) {
                failCosmos++;
                console.error("Cosmos task failed:", e);
            }
        }));
    }

    await Promise.allSettled(tasks);
    console.log('All txs are sent and settled');
    const evmSamples    = monitor.queue.filter(q => q.chain === "evm");
    const cosmosSamples = monitor.queue.filter(q => q.chain === "cosmos");

    function stats(arr: number[]) {
        const sum = arr.reduce((a, b) => a + b, 0);
        return {
            count: arr.length,
            min  : Math.min(...arr),
            max  : Math.max(...arr),
            avg  : +(sum / arr.length).toFixed(2),
        };
    }

    console.log("\n=== Latency stats (ms) ===");
    console.log("EVM Broadcast :", stats(evmSamples.map(s => s.txBroadcastLatency)));
    console.log("EVM Inclusion :", stats(evmSamples.map(s => s.blockInclusionLatency)));
    console.log("Cos Broadcast :", stats(cosmosSamples.map(s => s.txBroadcastLatency)));
    console.log("Cos Inclusion :", stats(cosmosSamples.map(s => s.blockInclusionLatency)));


    const evmBlocks   = new Set<number>();
    const cosmosHeights = new Set<number>();

    latencyResults.forEach(r => {
        if (r.blockNumber !== undefined){
            evmBlocks.add(r.blockNumber);
            cosmosHeights.add(r.blockNumber);
        }
    });

// Query EVM blocks for gas + txCount ------------------------------------
    /*for (const height of evmBlocks) {
        try {
            const blk = await rpcProvider.getBlock(height);
            console.log(`EVM  Block 0x${height.toString(16)}: txs=${blk.transactions.length}, gasUsed=${blk.gasUsed}`);
        } catch (e) {
            console.error("Failed to fetch EVM block", height, e);
        }
    }*/

// Query Cosmos blocks for txCount (no gas) ------------------------------
    /*for (const h of cosmosHeights) {
        try {
            const block = await admin.seiWallet.signingClient.getBlock(Number(h));
            console.log(`Cosmos Block ${h}: txs=${block.txs.length}`);
        } catch (e) {
            console.error("Failed to fetch Cosmos block", h, e);
        }
    }*/

    console.log("\n=== TX outcome summary ===");
    console.log(`EVM    success: ${successEvm}/${CONFIG.TOTAL_TXS}  (${((successEvm/CONFIG.TOTAL_TXS)*100).toFixed(2)}%)  failures: ${failEvm}`);
    console.log(`Cosmos success: ${successCosmos}/${CONFIG.TOTAL_TXS}  (${((successCosmos/CONFIG.TOTAL_TXS)*100).toFixed(2)}%)  failures: ${failCosmos}`);
}

main().catch(console.error);

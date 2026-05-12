// Pre-uploads cw20_base.wasm through a patient cosmjs client (180s)
// before fixture work. On fresh chains, libwasmvm's first wasm-store
// validation in CheckTx exceeds both cosmjs's default 60s broadcast
// timeout and the orchestrator's 60s mempool.ttl_duration — the tx is
// evicted or polled-past before inclusion. See qa-testing#85.
//
// The code_id is cached on TokenDeployer so the subsequent
// deployer.deployCw20(cw20_base) call reuses it instead of broadcasting
// a second identical upload. Public chains skip entirely.

import {SigningCosmWasmClient} from "@cosmjs/cosmwasm-stargate";
import {calculateFee, GasPrice} from "@cosmjs/stargate";
import fs from "fs";
import path from "path";
import {SeiUser} from "./User";
import {TokenDeployer} from "./Deployer";
import {isPublicChain} from "./chainParams";

const WARMUP_WASM_PATH = "wasm_store/cw20_base.wasm";
const WARMUP_BROADCAST_TIMEOUT_MS = 180_000;
const WARMUP_POLL_INTERVAL_MS = 3_000;
const WARMUP_GAS_PRICE = "0.25usei";
const WARMUP_FEE = calculateFee(10_000_000, "3.5usei");

export async function warmupChain(admin: SeiUser, chainId: string): Promise<void> {
    if (isPublicChain(chainId)) return;
    console.log(`[warmup] chain-id "${chainId}" not a public chain; treating as ephemeral`);

    const absPath = path.resolve(WARMUP_WASM_PATH);
    const wasm = fs.readFileSync(absPath);

    // cosmjs `broadcastTimeoutMs` is fixed at client construction;
    // dedicated client so the admin's downstream calls keep their 60s
    // ceiling and fail fast on post-warmup regressions.
    const patient = await SigningCosmWasmClient.connectWithSigner(
        admin.seiRpcEndpoint,
        admin.seiWallet.wallet,
        {
            gasPrice: GasPrice.fromString(WARMUP_GAS_PRICE),
            broadcastTimeoutMs: WARMUP_BROADCAST_TIMEOUT_MS,
            broadcastPollIntervalMs: WARMUP_POLL_INTERVAL_MS,
        },
    );

    try {
        console.log(`[warmup] uploading ${WARMUP_WASM_PATH} (timeout ${WARMUP_BROADCAST_TIMEOUT_MS}ms)`);
        const res = await patient.upload(admin.seiAddress, wasm, WARMUP_FEE, "warmup");
        TokenDeployer.recordWasmCode(absPath, res.codeId);
        console.log(`[warmup] complete, codeId=${res.codeId}`);
    } finally {
        patient.disconnect();
    }
}

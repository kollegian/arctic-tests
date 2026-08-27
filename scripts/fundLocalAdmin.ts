/** Fund and associate a disposable mnemonic on the local Sei Docker devnet. */
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { coins } from '@cosmjs/amino';
import { DirectSecp256k1HdWallet, Registry } from '@cosmjs/proto-signing';
import {
    assertIsDeliverTxSuccess,
    defaultRegistryTypes,
    SigningStargateClient,
    StargateClient,
} from '@cosmjs/stargate';
import { seiProtoRegistry, Encoder } from '@sei-js/cosmos/encoding';
import { ethers } from 'ethers';

const execFile = promisify(execFileCallback);
const EVM_RPC = process.env.LOCAL_EVM_RPC ?? 'http://localhost:8545';
const COSMOS_RPC = process.env.SEI_COSMOS_RPC ?? 'http://localhost:26657';
const ADMIN_MNEMONIC =
    process.env.SEI_ADMIN_MNEMONIC ??
    'cover brand danger absent gas worth sustain rural powder auction shadow find merge domain promote glimpse burger embody favorite lake rain plate present soda';
const HD_PATH = "m/44'/118'/0'/0/0";
const DOCKER_NODE = 'sei-node-0';
const KEY_PASSWORD = '12345678';
const FUND_USEI = '1000000000000';

async function waitFor(
    predicate: () => Promise<boolean>,
    label: string,
    timeoutMs = 30_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`timed out waiting for ${label}`);
}

async function seiWallet(): Promise<DirectSecp256k1HdWallet> {
    return DirectSecp256k1HdWallet.fromMnemonic(ADMIN_MNEMONIC, {
        prefix: 'sei',
    });
}

async function fundCosmosAddress(address: string): Promise<void> {
    const shellPrefix = 'export PATH=$PATH:/root/go/bin:/root/.foundry/bin';
    const { stdout } = await execFile('docker', [
        'exec',
        DOCKER_NODE,
        '/bin/bash',
        '-c',
        `${shellPrefix} && printf "${KEY_PASSWORD}\\n" | seid keys show admin -a`,
    ]);
    const source = stdout.trim();
    await execFile('docker', [
        'exec',
        DOCKER_NODE,
        '/bin/bash',
        '-c',
        `${shellPrefix} && printf "${KEY_PASSWORD}\\n" | seid tx bank send ${source} ${address} ${FUND_USEI}usei --fees 24500usei -y`,
    ]);
}

async function associate(address: string): Promise<void> {
    const wallet = await seiWallet();
    const registry = new Registry([...seiProtoRegistry, ...defaultRegistryTypes]);
    const client = await SigningStargateClient.connectWithSigner(
        COSMOS_RPC,
        wallet,
        { registry },
    );
    try {
        const result = await client.signAndBroadcast(
            address,
            [
                {
                    typeUrl: `/${Encoder.evm.MsgAssociate.$type}`,
                    value: Encoder.evm.MsgAssociate.fromPartial({
                        sender: address,
                        custom_message: 'EEST GitHub runner bootstrap',
                    }),
                },
            ],
            { amount: coins(21000, 'usei'), gas: '200000' },
            'associate EEST runner',
        );
        assertIsDeliverTxSuccess(result);
    } finally {
        client.disconnect();
    }
}

async function main(): Promise<void> {
    const evm = new ethers.JsonRpcProvider(EVM_RPC);
    const evmAdmin = ethers.HDNodeWallet.fromPhrase(ADMIN_MNEMONIC, '', HD_PATH);
    const wallet = await seiWallet();
    const [account] = await wallet.getAccounts();
    const cosmos = await StargateClient.connect(COSMOS_RPC);

    try {
        if ((await evm.getBalance(evmAdmin.address)) > 0n) return;
        await fundCosmosAddress(account.address);
        await waitFor(
            async () => BigInt((await cosmos.getBalance(account.address, 'usei')).amount) > 0n,
            'Cosmos funding transaction',
        );
        await associate(account.address);
        await waitFor(
            async () => (await evm.getBalance(evmAdmin.address)) > 0n,
            'EVM account association',
        );
        console.log(`funded EEST account ${evmAdmin.address}`);
    } finally {
        cosmos.disconnect();
        await evm.destroy();
    }
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});

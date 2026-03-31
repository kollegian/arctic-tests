import {SeiUser} from "../../../shared/User";
import {Contract, ethers} from "ethers";
import {Erc20Token} from "../../../shared/Token";
import {toRlp, zeroAddress} from "viem";


export async function signAuthorization(user: SeiUser, accountImplementationAddress: string, chainIdOverride?: bigint | number, nonceOverride?: bigint | number) {
    const { chainId } = await user.evmWallet.signingClient.getNetwork();
    const nonce = await computeNonce(user);
    const selectedChainId = chainIdOverride ?? chainId;
    const selectedNonce = nonceOverride ?? nonce;
    return user.evmWallet.wallet.authorize({
        address: accountImplementationAddress,
        chainId: selectedChainId as any,
        nonce: selectedNonce as any,
    });
}

async function computeNonce(user: SeiUser) {
    const latest = await user.evmWallet.signingClient.getTransactionCount(user.evmAddress, "latest");
    return BigInt(latest + 1);
}

export async function createSelfAuthorization(
    user: SeiUser,
    accountImplementationAddress: string,
    chainIdPassed?: bigint | number,
    noncePassed?: bigint | number
) {
    const { chainId } = await user.evmWallet.signingClient.getNetwork();
    const nonce = await computeNonce(user);
    const selectedChainId = chainIdPassed ?? chainId;
    const selectedNonce = noncePassed ?? nonce;

    return await user.evmWallet.wallet.authorize({
        address: accountImplementationAddress,
        chainId: selectedChainId as any,
        nonce: selectedNonce as any,
    });
}

export async function setCodeForEOA(user: SeiUser, auth: ethers.Authorization[], sender?: SeiUser) {
    const eoaAddr = user.evmAddress;
    const provider = user.evmWallet.signingClient;
    let tx: ethers.TransactionResponse;
    if (sender) {
        tx = await sender.evmWallet.wallet.sendTransaction({
            to: eoaAddr,
            data: "0x",
            maxFeePerGas: (await provider.getFeeData()).maxFeePerGas!,
            maxPriorityFeePerGas: (await provider.getFeeData()).maxPriorityFeePerGas!,
            authorizationList: auth,
            type: 4,
        });
    } else {
        tx = await user.evmWallet.wallet.sendTransaction({
            to: eoaAddr,
            data: "0x",
            maxFeePerGas: (await provider.getFeeData()).maxFeePerGas!,
            maxPriorityFeePerGas: (await provider.getFeeData()).maxPriorityFeePerGas!,
            authorizationList: auth,
            type: 4,
        });
    }

    return await tx.wait();
}

export async function setCodeWithoutChecks(user: SeiUser, auth: ethers.Authorization | null) {
    const provider = user.evmWallet.signingClient;

    const serializeQuantity = (value: any) => ethers.toQuantity(BigInt(value));
    let serializedAuth: any = null;
    if (auth) {
        serializedAuth = {
            address: (auth as any).address,
            chainId: serializeQuantity((auth as any).chainId),
            nonce: serializeQuantity((auth as any).nonce),
            r: (auth as any).signature.r,
            s: (auth as any).signature.s,
            yParity: serializeQuantity((auth as any).signature.yParity),
        } as any;
    }
    console.log('serialized');
    const fee = await provider.getFeeData();
    const txParams = {
        from: user.evmAddress,
        to: user.evmAddress,
        data: '0x',
        maxFeePerGas: ethers.toQuantity(fee.maxFeePerGas!),
        maxPriorityFeePerGas: ethers.toQuantity(fee.maxPriorityFeePerGas!),
        authorizationList: [ serializedAuth ],
    } as any;
    return await user.evmWallet.wallet.sendTransaction(txParams);
}

export async function sendAuthorizedTx(
    relayer: SeiUser,
    targetAddress: string,
    auth: ethers.Authorization,
    data: string = "0x"
) {
    const provider = relayer.evmWallet.signingClient;
    const tx = await relayer.evmWallet.wallet.sendTransaction({
        to: targetAddress,
        data,
        maxFeePerGas: (await provider.getFeeData()).maxFeePerGas!,
        maxPriorityFeePerGas: (await provider.getFeeData()).maxPriorityFeePerGas!,
        authorizationList: [auth],
        type: 4,
    });
    return tx.wait();
}

export async function sendBatchTxs(
    sender: SeiUser,
    txs: Array<{ target: string, value: bigint, data: string }>,
    accountContract: Contract,
    opts?: { eoaAddress?: string}
) {
    if (opts?.eoaAddress) {
        const data = accountContract.interface.encodeFunctionData('executeBatch', [txs]);
        const provider = sender.evmWallet.signingClient;
        const tx = await sender.evmWallet.wallet.sendTransaction({
            to: opts.eoaAddress,
            data,
            maxFeePerGas: (await provider.getFeeData()).maxFeePerGas!,
            maxPriorityFeePerGas: (await provider.getFeeData()).maxPriorityFeePerGas!,
        });
        return await tx.wait();
    }

    // Default path: call implementation directly (works if EOA code already set)
    const sentTxs = await (accountContract.connect(sender.evmWallet.wallet) as any).executeBatch(txs);
    return await sentTxs.wait();
}

export async function sendTxWithAuthorizationList(
    sender: SeiUser,
    to: string,
    data: string,
    authorizationList: ethers.Authorization[]
) {
    const provider = sender.evmWallet.signingClient;
    const tx = await sender.evmWallet.wallet.sendTransaction({
        to,
        data,
        maxFeePerGas: (await provider.getFeeData()).maxFeePerGas!,
        maxPriorityFeePerGas: (await provider.getFeeData()).maxPriorityFeePerGas!,
        authorizationList,
    });
    return tx.wait();
}

export function getAccountAbi(){
    return [{
        "inputs": [{
            "components": [{
                "internalType": "address",
                "name": "target",
                "type": "address"
            }, {"internalType": "uint256", "name": "value", "type": "uint256"}, {
                "internalType": "bytes",
                "name": "data",
                "type": "bytes"
            }], "internalType": "struct BaseAccount.Call[]", "name": "calls", "type": "tuple[]"
        }],
        "name": "executeBatch",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }];
}

export function returnMintAndApproveCalls(erc20: Erc20Token, amount: bigint, to: string) {
    return [{
        target: erc20.getAddress() as unknown as string,
        value: 0n,
        data: erc20.contract.interface.encodeFunctionData("mint", [to, amount])
    }, {
        target: erc20.getAddress() as unknown as string,
        value: 0n,
        data: erc20.contract.interface.encodeFunctionData("approve", [to, amount])
    }];
}

export function returnBatchMintCalls(erc20: Erc20Token, amount: bigint, to: string) {
    return [{
        target: erc20.getAddress() as unknown as string,
        value: 0n,
        data: erc20.contract.interface.encodeFunctionData("mint", [to, amount])
    }, {
        target: erc20.getAddress() as unknown as string,
        value: 0n,
        data: erc20.contract.interface.encodeFunctionData("mint", [to, amount])
    }];
}

export async function clearSetCode(user: SeiUser) {
    const auth = await createSelfAuthorization(user, zeroAddress);
    // Use locally signed type-4 tx instead of eth_sendTransaction (which requires hosted key)
    return await setCodeForEOA(user, [auth]);
}

export async function sponsorAuthorizeAndExecuteBatch(
    relayer: SeiUser,                                  // the fee payer / tx sender
    delegator: SeiUser,                                    // the delegating EOA
    accountImplementation: string,                     // smart account implementation address
    txs: Array<{ target: string; value: bigint; data: string }>,
    authOverride?: ethers.Authorization                // optional: pre-signed auth from Alice
) {
    const provider = relayer.evmWallet.signingClient;

    const auth = authOverride ?? await delegator.evmWallet.wallet.authorize({
        address: accountImplementation,
        chainId: (await provider.getNetwork()).chainId as any,
        // NOTE: use Alice's CURRENT nonce (no +1). If you already have your own helper, use it.
        nonce: await delegator.evmWallet.signingClient.getTransactionCount(delegator.evmAddress, "latest") as any,
    });

    // (b) encode executeBatch using the ACCOUNT ABI but target **Alice's EOA**
    const accountIface = new ethers.Interface(getAccountAbi());
    const data = accountIface.encodeFunctionData("executeBatch", [txs]);

    // (c) build & send a type-0x04 tx from relayer
    const fee = await provider.getFeeData();
    const tx = await relayer.evmWallet.wallet.sendTransaction({
        to: delegator.evmAddress,               // IMPORTANT: call Alice's EOA (now delegated)
        data,
        maxFeePerGas: fee.maxFeePerGas!,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas!,
        authorizationList: [auth],
        type: 4,
    });

    return tx.wait();
}

export async function buildAndSignType4RawTxNoValidation({
                                                             wallet,          // ethers.Wallet (has private key)
                                                             chainId,         // number | bigint
                                                             outerNonce,      // number | bigint  (sender's tx nonce)
                                                             maxPriorityFeePerGas,
                                                             maxFeePerGas,
                                                             gasLimit,
                                                             to,              // destination address string OR "0x000...0" for zero (we'll treat zero as empty)
                                                             value = 0n,
                                                             data = "0x",
                                                             authorizationTuples = [] as Array<any>, // array of tuples you control: { chainId, address, nonce, yParity, r, s }
                                                         }: {
    wallet: ethers.Wallet;
    chainId: number | bigint;
    outerNonce: number | bigint;
    maxPriorityFeePerGas: bigint;
    maxFeePerGas: bigint;
    gasLimit: bigint;
    to: string;
    value?: bigint;
    data?: string;
    authorizationTuples?: Array<any>;
}) {
    // helpers: convert to Buffer as RLP expects
    const toBufQuantity = (v: any) => {
        const n = BigInt(v ?? 0);
        if (n === 0n) return Buffer.from([]);
        const hex = n.toString(16);
        return Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
    };
    const toBufAddress = (a?: string) => {
        if (!a) return Buffer.from([]);
        const cleaned = a.replace(/^0x/, "");
        // treat zero address as empty buffer (per your test)
        if (/^0+$/.test(cleaned)) return Buffer.from([]);
        return Buffer.from(cleaned.padStart(40, "0"), "hex");
    };
    const toBufData = (d?: string) => {
        if (!d || d === "0x") return Buffer.from([]);
        return Buffer.from(d.replace(/^0x/, ""), "hex");
    };

    // Build the authorization tuples as nested arrays of buffers:
    // each tuple: [chainId, address, nonce, yParity, r, s]
    const authTuplesForRlp = (authorizationTuples || []).map((t) => {
        // r and s are always 32-byte hex strings, must keep leading zeros
        const rHex = String(t.r).replace(/^0x/, "").padStart(64, "0");
        const sHex = String(t.s).replace(/^0x/, "").padStart(64, "0");
        return [
            toBufQuantity(t.chainId ?? 0),
            toBufAddress(t.address ?? "0x0"),
            toBufQuantity(t.nonce ?? 0),
            toBufQuantity(t.yParity ?? 0),
            Buffer.from(rHex, "hex"),
            Buffer.from(sHex, "hex"),
        ];
    });

    // Build unsigned tx array in spec order:
    // [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit,
    //  destination, value, data, accessList, authorizationList]
    // accessList we keep empty [] (no entries)
    const unsignedArray: any[] = [
        toBufQuantity(chainId),
        toBufQuantity(outerNonce),
        toBufQuantity(maxPriorityFeePerGas),
        toBufQuantity(maxFeePerGas),
        toBufQuantity(gasLimit),
        toBufAddress(to),
        toBufQuantity(value),
        toBufData(data),
        [], // accessList empty
        authTuplesForRlp,
    ];

    // RLP encode unsigned using viem
    const toHexOrArray = (x: any): any => {
        if (Buffer.isBuffer(x)) return ('0x' + x.toString('hex')) as `0x${string}`;
        if (Array.isArray(x)) return x.map((y: any) => toHexOrArray(y));
        return x;
    };
    const rlpUnsignedHex = toRlp(unsignedArray.map((x: any) => toHexOrArray(x)) as any) as `0x${string}`;
    const digest = ethers.keccak256(ethers.concat([Uint8Array.from([0x04]), ethers.getBytes(rlpUnsignedHex)]));

    // Sign digest with SigningKey (ethers v6)
    const sk = new ethers.SigningKey(wallet.privateKey);
    const sig = sk.sign(ethers.getBytes(digest));
    const yParity = BigInt(Number(sig.v) % 2);

    // Append signature fields to unsignedArray to create signedFields
    // Pad r and s to 32 bytes (64 hex chars) to preserve leading zeros
    const rHex = sig.r.replace(/^0x/, '').padStart(64, '0');
    const sHex = sig.s.replace(/^0x/, '').padStart(64, '0');
    const signedArray = unsignedArray.concat([
        toBufQuantity(yParity),
        Buffer.from(rHex, 'hex'),
        Buffer.from(sHex, 'hex'),
    ]);

    const rlpSignedHex = toRlp(signedArray.map((x: any) => toHexOrArray(x)) as any) as `0x${string}`;
    const raw = '0x04' + rlpSignedHex.slice(2);

    return raw;
}

// Simple wrapper for tests - just pass user and auth list, everything else is auto-filled
export async function buildRawSetCodeTx(user: SeiUser, authList: ethers.Authorization[], overrides?: { to?: string; data?: string; nonce?: number | bigint }): Promise<string> {
    const provider = user.evmWallet.signingClient;
    const fee = await provider.getFeeData();
    const { chainId } = await provider.getNetwork();
    const nonce = overrides?.nonce ?? await provider.getTransactionCount(user.evmAddress, 'latest');

    // Convert ethers.Authorization to the format expected by buildAndSignType4RawTxNoValidation
    const authorizationTuples = authList.map(auth => ({
        chainId: auth.chainId,
        address: auth.address,
        nonce: auth.nonce,
        yParity: auth.signature.yParity,
        r: auth.signature.r,
        s: auth.signature.s,
    }));

    const raw = await buildAndSignType4RawTxNoValidation({
        wallet: user.evmWallet.wallet as any,
        chainId,
        outerNonce: nonce,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas!,
        maxFeePerGas: fee.maxFeePerGas!,
        gasLimit: 110000n,
        to: overrides?.to ?? user.evmAddress,
        value: 0n,
        data: overrides?.data ?? '0x',
        authorizationTuples,
    });

    return await broadcastRawTransaction(user, raw);
}

export async function broadcastRawTransaction(user: SeiUser, rawSignedHex: string): Promise<string> {
    const provider = user.evmWallet.signingClient;
    return await provider.send('eth_sendRawTransaction', [rawSignedHex]);
}

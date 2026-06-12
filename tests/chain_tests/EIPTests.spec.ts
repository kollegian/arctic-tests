import { ethers } from 'ethers';
import { expect } from 'chai';
import { bothProviders } from '../new_rpc_tests/utils/providers';
import { rawSei, rawGeth } from '../new_rpc_tests/utils/rpc';
import { readRuntimeState, RuntimeState } from '../new_rpc_tests/utils/state';
import { abiOf, bytecodeOf } from '../new_rpc_tests/utils/deploy';
import { EvmAccount } from '../new_rpc_tests/utils/wallet';
import { claimPool } from '../new_rpc_tests/utils/testHelpers';

/**
 * EIP behaviour suite — EVM features added to Ethereum after London/Merge/Shanghai/
 * Cancun, focused on where Sei deviates from upstream go-ethereum. SELFDESTRUCT
 * (EIP-6780) is first and most thorough: Sei had an app-hash incident on
 * self-destruct, so the post-state is asserted precisely on both the
 * pre-existing-contract path and the create-and-destruct-in-one-tx path.
 *
 * Every contract is deployed identically on Sei and a local `geth --dev`, so each
 * behaviour is checked apples-to-apples. Sei-only deviations are labelled.
 *
 * Block-context opcodes (BASEFEE, PREVRANDAO, COINBASE, BLOCKHASH) are observed from
 * inside a *mined* transaction that emits them — eth_call uses a synthetic context
 * where BASEFEE/PREVRANDAO read as 0 on geth too, so view calls are not a reliable
 * probe.
 *
 * Requires `yarn rpc:bootstrap` and a live geth --dev on RPC_ETH_GETH.
 */
describe('EIP behaviours (Sei vs geth)', function () {
    this.timeout(300 * 1000);

    const { sei, geth } = bothProviders();

    const destructibleAbi = abiOf('SelfDestructLab.sol', 'Destructible');
    const destructibleBytecode = bytecodeOf('SelfDestructLab.sol', 'Destructible');
    const factoryAbi = abiOf('SelfDestructLab.sol', 'DestructFactory');
    const factoryBytecode = bytecodeOf('SelfDestructLab.sol', 'DestructFactory');
    const probeAbi = abiOf('EipProbe.sol', 'EipProbe');
    const probeBytecode = bytecodeOf('EipProbe.sol', 'EipProbe');
    const create2FactoryAbi = abiOf('Create2Target.sol', 'Create2Factory');
    const create2FactoryBytecode = bytecodeOf('Create2Target.sol', 'Create2Factory');
    const probeIface = new ethers.Interface(probeAbi);

    let runtime: RuntimeState;
    let seiActor: EvmAccount;
    let gethSigner: ethers.NonceManager;
    let gethChain: Promise<unknown> = Promise.resolve();

    function serializeGeth<T>(fn: () => Promise<T>): Promise<T> {
        const next = gethChain.then(fn, fn);
        gethChain = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }

    async function deployWith(
        signer: ethers.Signer,
        abi: any[],
        bytecode: string,
        args: unknown[] = [],
        overrides: ethers.Overrides = {},
    ): Promise<{ contract: ethers.Contract; address: string; receipt: ethers.TransactionReceipt }> {
        const factory = new ethers.ContractFactory(abi, bytecode, signer);
        const contract = (await factory.deploy(...args, overrides)) as ethers.BaseContract;
        const receipt = await contract.deploymentTransaction()!.wait();
        return {
            contract: contract as ethers.Contract,
            address: await contract.getAddress(),
            receipt: receipt!,
        };
    }

    const deploySei = (abi: any[], bytecode: string, args: unknown[] = [], overrides: ethers.Overrides = {}) =>
        deployWith(seiActor.wallet, abi, bytecode, args, overrides);
    const deployGeth = (abi: any[], bytecode: string, args: unknown[] = [], overrides: ethers.Overrides = {}) =>
        serializeGeth(() => deployWith(gethSigner, abi, bytecode, args, overrides));

    // Run a state-changing contract method (on geth, serialised) and wait for it.
    const sendGeth = (fn: () => Promise<ethers.ContractTransactionResponse>) =>
        serializeGeth(async () => (await fn()).wait());

    // Send emitContext() and decode the Context event into its fields.
    async function readContext(
        provider: ethers.JsonRpcProvider,
        probeAddress: string,
        sendTx: () => Promise<ethers.TransactionReceipt | null>,
    ) {
        const receipt = await sendTx();
        const log = receipt!.logs
            .map(l => {
                try {
                    return probeIface.parseLog(l);
                } catch {
                    return null;
                }
            })
            .find(p => p?.name === 'Context');
        if (!log) throw new Error('Context event not found in emitContext() receipt');
        const blockNumber = log.args.blockNumber as bigint;
        const header = await provider.send('eth_getBlockByNumber', [
            '0x' + blockNumber.toString(16),
            false,
        ]);
        return {
            blockNumber,
            baseFee: log.args.baseFee as bigint,
            prevRandao: log.args.prevRandao as bigint,
            coinbase: (log.args.coinbase as string).toLowerCase(),
            parentHash: log.args.parentHash as string,
            header,
        };
    }

    let seiSink: string;
    let gethSink: string;

    before(async () => {
        runtime = readRuntimeState();
        const claimed = claimPool(runtime, sei, 2, 'EIPTests-sei');
        seiActor = claimed[0];
        seiSink = claimed[1].address;
        gethSigner = new ethers.NonceManager(
            new ethers.Wallet(runtime.funded.gethAdmin.privateKey, geth),
        );
        // Pre-create a funded geth recipient so the self-destruct transfer lands on an
        // existing account.
        const sinkWallet = ethers.Wallet.createRandom();
        gethSink = sinkWallet.address;
        await serializeGeth(async () => {
            const tx = await gethSigner.sendTransaction({
                to: gethSink,
                value: ethers.parseEther('1'),
            });
            await tx.wait();
        });
    });

    describe('SELFDESTRUCT (EIP-6780)', () => {
        async function preexistingDestructScenario(
            deployFn: typeof deploySei,
            provider: ethers.JsonRpcProvider,
            recipient: string,
            isGeth: boolean,
        ) {
            const funding = ethers.parseEther('0.01');
            const { contract, address } = await deployFn(destructibleAbi, destructibleBytecode, [], {
                value: funding,
            });

            const codeBefore = await provider.getCode(address);
            const storageBefore = await provider.getStorage(address, 0);
            expect(await provider.getBalance(address)).to.equal(funding);
            expect(codeBefore).to.not.equal('0x');

            const doDestroy = () => contract.destroy(recipient) as Promise<ethers.ContractTransactionResponse>;
            const dr = isGeth ? await sendGeth(doDestroy) : await (await doDestroy()).wait();
            // Pin post-state reads to the destroy block. geth --dev instamines, so a
            // bare `latest` read can race ahead/behind the block that applied the
            // SELFDESTRUCT; explicit block tags make the assertion deterministic. The
            // recipient is passive (not the gas payer), so its gain across the destroy
            // block is exactly the transferred balance.
            const at = dr!.blockNumber;
            const recipientBefore = await provider.getBalance(recipient, at - 1);

            return {
                funding,
                address,
                codeBefore,
                storageBefore,
                codeAfter: await provider.getCode(address, at),
                storageAfter: await provider.getStorage(address, 0, at),
                balanceAfter: await provider.getBalance(address, at),
                recipientGain: (await provider.getBalance(recipient, at)) - recipientBefore,
            };
        }

        it('[Sei-specific] a pre-existing contract is NOT deleted; only its balance moves (Sei)', async () => {
            // Send to an existing, funded recipient so the assertion is about EIP-6780
            // deletion semantics, not account-creation-on-transfer edge cases.
            const r = await preexistingDestructScenario(deploySei, sei, seiSink, false);
            expect(r.codeAfter, 'code must survive SELFDESTRUCT for a pre-existing contract').to.equal(
                r.codeBefore,
            );
            expect(r.storageAfter, 'storage must survive').to.equal(r.storageBefore);
            expect(r.balanceAfter, 'contract balance must be drained to 0').to.equal(0n);
            expect(r.recipientGain, 'recipient receives the full balance').to.equal(r.funding);
        });

        it('geth shows the identical EIP-6780 post-state for a pre-existing contract', async () => {
            const r = await preexistingDestructScenario(deployGeth, geth, gethSink, true);
            expect(r.codeAfter, 'geth: code survives').to.equal(r.codeBefore);
            expect(r.storageAfter, 'geth: storage survives').to.equal(r.storageBefore);
            expect(r.balanceAfter, 'geth: balance drained').to.equal(0n);
            expect(r.recipientGain, 'geth: recipient credited').to.equal(r.funding);
        });

        async function sameTxDestructScenario(
            deployFn: typeof deploySei,
            provider: ethers.JsonRpcProvider,
            isGeth: boolean,
        ) {
            const { contract: factory } = await deployFn(factoryAbi, factoryBytecode);
            const funding = ethers.parseEther('0.005');
            const recipient = ethers.Wallet.createRandom().address;

            const predicted: string = await factory.deployAndDestroyInSameTx.staticCall(recipient, {
                value: funding,
            });
            const doIt = () =>
                factory.deployAndDestroyInSameTx(recipient, {
                    value: funding,
                }) as Promise<ethers.ContractTransactionResponse>;
            const r = isGeth ? await sendGeth(doIt) : await (await doIt()).wait();
            const at = r!.blockNumber;
            const recipientBefore = await provider.getBalance(recipient, at - 1);

            return {
                funding,
                predicted,
                codeAfter: await provider.getCode(predicted, at),
                storageAfter: await provider.getStorage(predicted, 0, at),
                balanceAfter: await provider.getBalance(predicted, at),
                recipientGain: (await provider.getBalance(recipient, at)) - recipientBefore,
            };
        }

        it('[Sei-specific] create-and-destruct in one tx DOES delete code + storage (Sei)', async () => {
            const r = await sameTxDestructScenario(deploySei, sei, false);
            expect(r.codeAfter, 'same-tx self-destruct must wipe code').to.equal('0x');
            expect(r.storageAfter, 'same-tx self-destruct must wipe storage').to.equal(ethers.ZeroHash);
            expect(r.balanceAfter, 'inner balance must be 0').to.equal(0n);
            expect(r.recipientGain, 'recipient gets the funded value').to.equal(r.funding);
        });

        it('geth shows the identical same-tx deletion post-state', async () => {
            const r = await sameTxDestructScenario(deployGeth, geth, true);
            expect(r.codeAfter, 'geth: same-tx wipes code').to.equal('0x');
            expect(r.storageAfter, 'geth: same-tx wipes storage').to.equal(ethers.ZeroHash);
            expect(r.balanceAfter, 'geth: inner balance 0').to.equal(0n);
            expect(r.recipientGain, 'geth: recipient credited').to.equal(r.funding);
        });

        it('SELFDESTRUCT-to-self keeps the balance for a pre-existing contract (no burn) on Sei', async () => {
            const funding = ethers.parseEther('0.01');
            const { contract, address } = await deploySei(destructibleAbi, destructibleBytecode, [], {
                value: funding,
            });
            await (await contract.destroyToSelf()).wait();
            expect(await sei.getBalance(address), 'self-directed SELFDESTRUCT must not burn').to.equal(
                funding,
            );
            expect(await sei.getCode(address), 'code survives (pre-existing)').to.not.equal('0x');
        });

        it('a destroyed pre-existing contract is still callable (code intact) on Sei', async () => {
            const { contract, address } = await deploySei(destructibleAbi, destructibleBytecode, [], {
                value: ethers.parseEther('0.001'),
            });
            await (await contract.destroy(ethers.Wallet.createRandom().address)).wait();
            const live = new ethers.Contract(address, destructibleAbi, sei);
            expect(await live.storedValue(), 'storedValue readable after self-destruct').to.equal(
                0xabcdefn,
            );
        });
    });

    describe('SSTORE gas — EIP-2200 / EIP-2929 (Sei overrides set-gas)', () => {
        async function gasForSet(
            contract: ethers.Contract,
            fn: 'setSlotA' | 'setSlotB',
            value: bigint,
            isGeth: boolean,
        ): Promise<bigint> {
            const send = () => contract[fn](value) as Promise<ethers.ContractTransactionResponse>;
            const receipt = isGeth ? await sendGeth(send) : await (await send()).wait();
            return receipt!.gasUsed;
        }

        it('zero→nonzero SSTORE costs more than nonzero→nonzero on both chains', async () => {
            const { contract: s } = await deploySei(probeAbi, probeBytecode);
            const { contract: g } = await deployGeth(probeAbi, probeBytecode);
            const seiSet = await gasForSet(s, 'setSlotA', 1n, false);
            const seiUpdate = await gasForSet(s, 'setSlotA', 2n, false);
            const gethSet = await gasForSet(g, 'setSlotA', 1n, true);
            const gethUpdate = await gasForSet(g, 'setSlotA', 2n, true);

            expect(seiSet > seiUpdate, `Sei: set ${seiSet} should exceed update ${seiUpdate}`).to.equal(
                true,
            );
            expect(
                gethSet > gethUpdate,
                `geth: set ${gethSet} should exceed update ${gethUpdate}`,
            ).to.equal(true);
        });

        it('[divergence-aware] zero→nonzero SSTORE gas, Sei vs geth', async () => {
            const { contract: s } = await deploySei(probeAbi, probeBytecode);
            const { contract: g } = await deployGeth(probeAbi, probeBytecode);
            const seiSet = await gasForSet(s, 'setSlotA', 1n, false);
            const gethSet = await gasForSet(g, 'setSlotA', 1n, true);
            expect(seiSet > 21_000n, `Sei set gas ${seiSet} must exceed intrinsic`).to.equal(true);
            expect(gethSet > 21_000n, `geth set gas ${gethSet} must exceed intrinsic`).to.equal(true);
            if (seiSet !== gethSet) {
                // eslint-disable-next-line no-console
                console.log(
                    `[SSTORE set-gas] Sei=${seiSet} geth=${gethSet} (delta ${seiSet - gethSet})`,
                );
            }
        });

        it('nonzero→zero SSTORE (refund path) nets below a fresh set on Sei', async () => {
            const { contract: s } = await deploySei(probeAbi, probeBytecode);
            const setGas = await gasForSet(s, 'setSlotA', 1n, false); // 0 -> nonzero
            const clearGas = await gasForSet(s, 'setSlotB', 0n, false); // nonzero -> 0 (refund)
            expect(clearGas < setGas, `clear ${clearGas} should net below set ${setGas}`).to.equal(
                true,
            );
        });
    });

    describe('warm COINBASE — EIP-3651', () => {
        async function checkWarmCoinbase(contract: ethers.Contract, label: string) {
            const coldProbe = ethers.Wallet.createRandom().address;
            const [coldOther, firstCb, secondCb]: [bigint, bigint, bigint, bigint] =
                await contract.coinbaseWarmthGas(coldProbe);
            expect(
                firstCb < coldOther,
                `${label}: first coinbase BALANCE (${firstCb}) must be cheaper than a cold read (${coldOther})`,
            ).to.equal(true);
            const warmDelta = firstCb > secondCb ? firstCb - secondCb : secondCb - firstCb;
            expect(
                warmDelta < 200n,
                `${label}: first(${firstCb}) and second(${secondCb}) coinbase reads should both be warm`,
            ).to.equal(true);
        }

        it('first BALANCE(block.coinbase) is warm on Sei', async () => {
            const { contract } = await deploySei(probeAbi, probeBytecode);
            await checkWarmCoinbase(contract, 'Sei');
        });

        it('first BALANCE(block.coinbase) is warm on geth (reference)', async () => {
            const { contract } = await deployGeth(probeAbi, probeBytecode);
            await checkWarmCoinbase(contract, 'geth');
        });
    });

    describe('block-context opcodes (BASEFEE / PREVRANDAO / COINBASE / BLOCKHASH)', () => {
        it('EIP-3198: BASEFEE (in a mined tx) equals the block header baseFeePerGas on Sei', async () => {
            const { contract, address } = await deploySei(probeAbi, probeBytecode);
            const ctx = await readContext(sei, address, async () =>
                (await contract.emitContext()).wait(),
            );
            expect(ctx.baseFee).to.equal(BigInt(ctx.header.baseFeePerGas));
        });

        it('EIP-3198: BASEFEE equals the header baseFeePerGas on geth', async () => {
            const { contract, address } = await deployGeth(probeAbi, probeBytecode);
            const ctx = await readContext(geth, address, () =>
                sendGeth(() => contract.emitContext()),
            );
            expect(ctx.baseFee).to.equal(BigInt(ctx.header.baseFeePerGas));
        });

        it('PREVRANDAO (in a mined tx) is nonzero and equals the block mixHash on Sei', async () => {
            const { contract, address } = await deploySei(probeAbi, probeBytecode);
            const ctx = await readContext(sei, address, async () =>
                (await contract.emitContext()).wait(),
            );
            expect(ctx.prevRandao, 'PREVRANDAO must be nonzero in a mined tx').to.not.equal(0n);
            // The header mixHash carries PREVRANDAO post-merge.
            if (ctx.header.mixHash && ctx.header.mixHash !== ethers.ZeroHash) {
                expect(ethers.toBeHex(ctx.prevRandao, 32)).to.equal(ctx.header.mixHash);
            }
        });

        it('PREVRANDAO changes block-to-block on Sei', async () => {
            const { contract, address } = await deploySei(probeAbi, probeBytecode);
            const a = await readContext(sei, address, async () => (await contract.emitContext()).wait());
            // Wait for a new block, then emit again.
            const start = a.blockNumber;
            const deadline = Date.now() + 20_000;
            while (BigInt(await sei.getBlockNumber()) === start && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 300));
            }
            const b = await readContext(sei, address, async () => (await contract.emitContext()).wait());
            expect(b.blockNumber > a.blockNumber, 'expected a new block').to.equal(true);
            expect(b.prevRandao).to.not.equal(a.prevRandao);
        });

        it('[Sei-specific] COINBASE opcode returns the fee_collector, not the block proposer', async () => {
            // On Sei the COINBASE opcode resolves to eth_coinbase (the fee_collector's
            // EVM address), which is fixed, while the block header `miner` is the
            // per-block proposer. On geth the two coincide. This is a deliberate Sei
            // deviation worth pinning so a future change is caught.
            const { contract, address } = await deploySei(probeAbi, probeBytecode);
            const ctx = await readContext(sei, address, async () =>
                (await contract.emitContext()).wait(),
            );
            const ethCoinbase = (await sei.send('eth_coinbase', [])).toLowerCase();
            expect(ctx.coinbase, 'COINBASE opcode should equal eth_coinbase on Sei').to.equal(
                ethCoinbase,
            );
            expect(
                ctx.coinbase,
                'COINBASE opcode diverges from the block proposer (miner) on Sei',
            ).to.not.equal(ctx.header.miner.toLowerCase());
        });

        it('on geth the COINBASE opcode equals the block miner (reference)', async () => {
            const { contract, address } = await deployGeth(probeAbi, probeBytecode);
            const ctx = await readContext(geth, address, () =>
                sendGeth(() => contract.emitContext()),
            );
            expect(ctx.coinbase).to.equal(ctx.header.miner.toLowerCase());
        });

        it('BLOCKHASH: blockhash(n-1) matches the real parent hash on Sei', async () => {
            const { contract, address } = await deploySei(probeAbi, probeBytecode);
            const ctx = await readContext(sei, address, async () =>
                (await contract.emitContext()).wait(),
            );
            const parent = await sei.send('eth_getBlockByNumber', [
                '0x' + (ctx.blockNumber - 1n).toString(16),
                false,
            ]);
            expect(ctx.parentHash).to.equal(parent.hash);
        });

        it('BLOCKHASH: blockhash(n-1) matches the real parent hash on geth', async () => {
            const { contract, address } = await deployGeth(probeAbi, probeBytecode);
            const ctx = await readContext(geth, address, () =>
                sendGeth(() => contract.emitContext()),
            );
            const parent = await geth.send('eth_getBlockByNumber', [
                '0x' + (ctx.blockNumber - 1n).toString(16),
                false,
            ]);
            expect(ctx.parentHash).to.equal(parent.hash);
        });

        it('BLOCKHASH: the current block and >256 blocks back return 0x0 on Sei', async () => {
            const { contract } = await deploySei(probeAbi, probeBytecode);
            const head = await sei.getBlockNumber();
            const current: string = await contract.currentBlockHash({ blockTag: head });
            expect(current, 'blockhash(current) must be 0x0').to.equal(ethers.ZeroHash);
            if (head > 300) {
                const old: string = await contract.blockHashOf(head - 300, { blockTag: head });
                expect(old, 'blockhash(head-300) must be 0x0').to.equal(ethers.ZeroHash);
            }
        });
    });

    describe('opcode correctness (CHAINID / PUSH0 / MCOPY / TSTORE)', () => {
        it('EIP-1344: CHAINID opcode equals eth_chainId on both chains', async () => {
            const { contract: s } = await deploySei(probeAbi, probeBytecode);
            const { contract: g } = await deployGeth(probeAbi, probeBytecode);
            const [seiOpcode, seiRpcId] = await Promise.all([
                s.chainId() as Promise<bigint>,
                sei.send('eth_chainId', []),
            ]);
            const [gethOpcode, gethRpcId] = await Promise.all([
                g.chainId() as Promise<bigint>,
                geth.send('eth_chainId', []),
            ]);
            expect(seiOpcode).to.equal(BigInt(seiRpcId));
            expect(gethOpcode).to.equal(BigInt(gethRpcId));
            expect(seiOpcode).to.equal(BigInt(runtime.chainIds.sei));
        });

        it('EIP-3855: a PUSH0-compiled contract deploys and runs (returns 0) on both chains', async () => {
            const { contract: s } = await deploySei(probeAbi, probeBytecode);
            const { contract: g } = await deployGeth(probeAbi, probeBytecode);
            expect(await s.pushZero()).to.equal(0n);
            expect(await g.pushZero()).to.equal(0n);
        });

        it('EIP-5656: MCOPY copies memory correctly on both chains', async () => {
            const payload = '0x' + 'deadbeef'.repeat(8) + '0102030405';
            const { contract: s } = await deploySei(probeAbi, probeBytecode);
            const { contract: g } = await deployGeth(probeAbi, probeBytecode);
            expect(await s.mcopy(payload)).to.equal(payload);
            expect(await g.mcopy(payload)).to.equal(payload);
        });

        it('EIP-1153: transient storage round-trips within a call on both chains', async () => {
            const { contract: s } = await deploySei(probeAbi, probeBytecode);
            const { contract: g } = await deployGeth(probeAbi, probeBytecode);
            expect(await s.transientRoundTrip.staticCall(0x1234n)).to.equal(0x1234n);
            expect(await g.transientRoundTrip.staticCall(0x1234n)).to.equal(0x1234n);
        });
    });

    describe('CREATE2 derivation', () => {
        it('a CREATE2-deployed address matches the keccak256(0xff..) derivation on Sei', async () => {
            const { contract: factory, address: factoryAddr } = await deploySei(
                create2FactoryAbi,
                create2FactoryBytecode,
            );
            const salt = ethers.id('eip-tests-create2-sei');
            const initCodeHash: string = await factory.initCodeHash();
            const expected = ethers.getCreate2Address(factoryAddr, salt, initCodeHash);
            expect(await factory.predict(salt)).to.equal(expected);

            const receipt = await (await factory.deploy(salt)).wait();
            const ev = receipt!.logs
                .map(l => {
                    try {
                        return factory.interface.parseLog(l);
                    } catch {
                        return null;
                    }
                })
                .find(p => p?.name === 'Deployed');
            expect(ev!.args.addr).to.equal(expected);
            expect(await sei.getCode(expected)).to.not.equal('0x');
        });

        it('the same CREATE2 derivation holds on geth', async () => {
            const { contract: factory, address: factoryAddr } = await deployGeth(
                create2FactoryAbi,
                create2FactoryBytecode,
            );
            const salt = ethers.id('eip-tests-create2-geth');
            const initCodeHash: string = await factory.initCodeHash();
            const expected = ethers.getCreate2Address(factoryAddr, salt, initCodeHash);
            await sendGeth(() => factory.deploy(salt));
            expect(await geth.getCode(expected)).to.not.equal('0x');
        });
    });

    describe('EXTCODEHASH / EXTCODESIZE', () => {
        const EMPTY_CODE_HASH =
            '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';

        it('EOA with no code has the empty-code keccak hash (or 0x0) and size 0 on Sei', async () => {
            const { contract } = await deploySei(probeAbi, probeBytecode);
            const eoa = ethers.Wallet.createRandom().address;
            const hash: string = await contract.extCodeHash(eoa);
            const size: bigint = await contract.extCodeSize(eoa);
            expect([EMPTY_CODE_HASH, ethers.ZeroHash]).to.include(hash);
            expect(size).to.equal(0n);
        });

        it('a deployed contract reports EXTCODESIZE == len(code) and EXTCODEHASH == keccak(code) on Sei', async () => {
            const { contract, address } = await deploySei(probeAbi, probeBytecode);
            const size: bigint = await contract.extCodeSize(address);
            const hash: string = await contract.extCodeHash(address);
            const code = await sei.getCode(address);
            expect(size).to.equal(BigInt((code.length - 2) / 2));
            expect(hash).to.equal(ethers.keccak256(code));
        });

        it('a precompile (ecrecover, 0x01) reports EXTCODESIZE 0 on Sei', async () => {
            const { contract } = await deploySei(probeAbi, probeBytecode);
            const ECRECOVER = '0x0000000000000000000000000000000000000001';
            expect(await contract.extCodeSize(ECRECOVER)).to.equal(0n);
        });
    });

    describe('EIP-4844 (blobs)', () => {
        it('BLOBHASH(i) returns 0x0 for a non-blob transaction context on both chains', async () => {
            const { contract: s } = await deploySei(probeAbi, probeBytecode);
            const { contract: g } = await deployGeth(probeAbi, probeBytecode);
            for (const [contract, label] of [
                [s, 'Sei'],
                [g, 'geth'],
            ] as [ethers.Contract, string][]) {
                for (const idx of [0n, 1n, 5n]) {
                    expect(await contract.blobHashAt(idx), `${label}: BLOBHASH(${idx})`).to.equal(
                        ethers.ZeroHash,
                    );
                }
            }
        });

        it('a blob-typed (type-3) raw transaction is rejected on Sei', async () => {
            // Sei does not support blob (type-3) txs. A 0x03-typed raw payload must be
            // refused (decode/type error) rather than accepted.
            const body = await rawSei('eth_sendRawTransaction', ['0x03f8']);
            expect(body.error, 'Sei must reject a blob-typed raw tx').to.not.equal(undefined);
        });

        it('[divergence-aware] eth_blobBaseFee on Sei vs geth', async () => {
            const [s, g] = await Promise.all([
                rawSei('eth_blobBaseFee', []),
                rawGeth('eth_blobBaseFee', []),
            ]);
            expect(g.result ?? g.error, 'geth must answer eth_blobBaseFee').to.not.equal(undefined);
            if (s.error) {
                // eslint-disable-next-line no-console
                console.log(`[eth_blobBaseFee] Sei error: ${JSON.stringify(s.error)}`);
            }
        });
    });
});

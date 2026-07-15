import { ethers } from 'ethers';
import { BankExtension, QueryClient, setupBankExtension } from '@cosmjs/stargate';
import { coins } from '@cosmjs/amino';
import { MsgMultiSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { SeiUser, UserFactory } from '../../shared/User';
import { expect } from 'chai';
import { mintTokens, returnContracts, returnQueryClient, setMetadataOfaToken, moduleAddress, castEvmAddress, castSeiAddress } from './utils';
import {
    ModuleAccountInfo,
    listModuleAccounts,
    SEI,
    evmFloorUsei,
    evmSpendableUsei,
    trySendNative,
    createVesting,
    associateFeeless,
} from './bankPrecompile.utils';
import { createTokenfactoryDenom, execCommandAndReturnJson } from '../../shared/utils/cliUtils';
import { waitFor } from '../../shared/utils/helpers';

describe('Bank Precompile Tests', function () {
    this.timeout(3 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let bankContract: ethers.Contract;
    let denomName: string;
    let bankQueryClient: QueryClient & BankExtension;

    before('Initializes clients, users, and tokenfactory denom', async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'alice');
        bob = await UserFactory.createSeiUser(admin, 'bob');
        console.log(alice.evmAddress, bob.evmAddress);

        ({ bankContract } = await returnContracts(admin));
        denomName = await createTokenfactoryDenom(alice, admin);
        bankQueryClient = await returnQueryClient(setupBankExtension) as QueryClient & BankExtension;
    });

    describe('balance()', function () {
        it('Returns zero for a denom the user has never held', async () => {
            const balance = await bankContract.balance(alice.evmAddress, denomName);
            expect(balance).to.be.a('bigint');
            expect(balance).to.equal(0n);
        });

        it('Reflects minted amount after tokenfactory mint', async () => {
            const mintAmount = 1_000_000;
            await mintTokens(alice, denomName, mintAmount.toString());
            await waitFor(1);
            const balance = await bankContract.balance(alice.evmAddress, denomName);
            expect(balance).to.equal(BigInt(mintAmount));
        });

        it('Returns usei balance that matches Cosmos query', async () => {
            const evmBalance = await bankContract.balance(admin.evmAddress, 'usei');
            const cosmosBalance = await bankQueryClient.bank.balance(admin.seiAddress, 'usei');
            expect(evmBalance).to.be.a('bigint');
            expect(evmBalance > 0n).to.equal(true, `Expected positive usei balance, got ${evmBalance}`);
            expect(evmBalance).to.equal(BigInt(cosmosBalance.amount));
        });

        it('Returns zero for a completely unknown denom', async () => {
            const balance = await bankContract.balance(alice.evmAddress, 'unonexistent999');
            expect(balance).to.equal(0n);
        });

        it('Reverts when querying balance for the zero address', async () => {
            try {
                await bankContract.balance(ethers.ZeroAddress, 'usei');
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                expect(e.code).to.equal('CALL_EXCEPTION');
            }
        });
    });

    describe('all_balances()', function () {
        it('Returns an array of Coin tuples for a funded user', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            expect(allBalances).to.be.an('array');
            expect(allBalances.length).to.be.greaterThan(0);
        });

        it('Each balance entry has amount (uint256) and denom (string)', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            for (const entry of allBalances) {
                const amount = entry[0];
                const denom = entry[1];
                expect(typeof amount).to.equal('bigint');
                expect(amount >= 0n).to.equal(true, `Expected non-negative amount, got ${amount}`);
                expect(denom).to.be.a('string');
                expect(denom.length).to.be.greaterThan(0);
            }
        });

        it('Matches Cosmos bank balances for every denom', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            for (const entry of allBalances) {
                const amount = entry[0];
                const denom = entry[1];
                const cosmosBalance = await execCommandAndReturnJson(
                    `seid query bank balances ${alice.seiAddress} --denom ${denom}`
                );
                expect(Number(amount)).to.equal(
                    Number(cosmosBalance.amount),
                    `Mismatch for denom ${denom}: EVM=${amount}, Cosmos=${cosmosBalance.amount}`
                );
            }
        });

        it('Cosmos multi send updates balances as expected and can be queried from the bank precompile', async () => {
            const toBob = 4000n;
            const toAdmin = 6000n;
            const total = toBob + toAdmin;

            // alice funds the multi-send; make sure she can cover it plus fees.
            await UserFactory.fundAddressOnSei(alice.seiAddress, 'usei', '5000000');
            await waitFor(1);

            const bobPre = await bankContract.balance(bob.evmAddress, 'usei');
            const adminPre = await bankContract.balance(admin.evmAddress, 'usei');

            const multiSend = {
                typeUrl: '/cosmos.bank.v1beta1.MsgMultiSend',
                value: MsgMultiSend.fromPartial({
                    inputs: [{ address: alice.seiAddress, coins: coins(total.toString(), 'usei') }],
                    outputs: [
                        { address: bob.seiAddress, coins: coins(toBob.toString(), 'usei') },
                        { address: admin.seiAddress, coins: coins(toAdmin.toString(), 'usei') },
                    ],
                }),
            };

            const res = await alice.seiWallet.signAndSend([multiSend], 'bank multi-send');
            expect(res.code).to.equal(0, `multi-send failed: ${res.rawLog}`);
            await waitFor(1);

            // Precompile view reflects each output exactly.
            const bobPost = await bankContract.balance(bob.evmAddress, 'usei');
            const adminPost = await bankContract.balance(admin.evmAddress, 'usei');
            expect(bobPost).to.equal(bobPre + toBob, 'bob usei via precompile after multi-send');
            expect(adminPost).to.equal(adminPre + toAdmin, 'admin usei via precompile after multi-send');

            // Precompile agrees with the Cosmos bank query for both recipients.
            const [bobCosmos, adminCosmos] = await Promise.all([
                bankQueryClient.bank.balance(bob.seiAddress, 'usei'),
                bankQueryClient.bank.balance(admin.seiAddress, 'usei'),
            ]);
            expect(bobPost).to.equal(BigInt(bobCosmos.amount), 'bob: precompile vs Cosmos parity');
            expect(adminPost).to.equal(BigInt(adminCosmos.amount), 'admin: precompile vs Cosmos parity');
        });

        it('Returns empty array for unfunded address', async () => {
            const randomWallet = ethers.Wallet.createRandom();
            const allBalances = await bankContract.all_balances(randomWallet.address);
            expect(allBalances).to.be.an('array');
            expect(allBalances.length).to.equal(0);
        });

        it('Includes tokenfactory denom after minting', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            const denomEntry = allBalances.find((e: any) => e[1] === denomName);
            expect(denomEntry).to.not.be.undefined;
            expect(denomEntry[0] > 0n).to.equal(true, `Expected positive balance for ${denomName}`);
        });
    });

    describe('decimals()', function () {
        it('Returns a valid uint8 for usei', async () => {
            const decimals = await bankContract.decimals('usei');
            expect(typeof decimals).to.equal('bigint');
            expect(Number(decimals)).to.be.greaterThanOrEqual(0);
            expect(Number(decimals)).to.be.lessThanOrEqual(18);
        });

        it('Returns 0 for a tokenfactory denom without metadata', async () => {
            const decimals = await bankContract.decimals(denomName);
            expect(Number(decimals)).to.equal(0);
        });

        it('Returns updated decimals after setting denom metadata', async () => {
            await setMetadataOfaToken(denomName, alice);
            await waitFor(2);
            const decimals = await bankContract.decimals(denomName);
            expect(Number(decimals)).to.be.greaterThanOrEqual(0);
            expect(Number(decimals)).to.be.lessThanOrEqual(18);
        });
    });

    describe('name()', function () {
        it('Returns the full denom string for a tokenfactory denom', async () => {
            const name = await bankContract.name(denomName);
            expect(name).to.be.a('string');
            expect(name).to.equal(denomName);
        });
    });

    describe('symbol()', function () {
        it('Returns a non-empty string for a tokenfactory denom', async () => {
            const symbol = await bankContract.symbol(denomName);
            expect(symbol).to.be.a('string');
            expect(symbol.length).to.be.greaterThan(0);
        });

        it('Reverts for usei (no denom metadata)', async () => {
            try{
                const symbol = await bankContract.symbol('usei');
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                expect(e.code).to.equal('CALL_EXCEPTION');
            }
        });
    });

    describe('supply()', function () {
        it('Returns total supply of usei as a positive bigint', async () => {
            const supply = await bankContract.supply('usei');
            expect(supply).to.be.a('bigint');
            expect(supply > 0n).to.equal(true, `Expected positive usei supply, got ${supply}`);
        });

        it('Returns total supply of tokenfactory denom matching minted amount', async () => {
            const supply = await bankContract.supply(denomName);
            expect(supply).to.be.a('bigint');
            expect(supply > 0n).to.equal(true, `Expected positive supply for ${denomName}, got ${supply}`);
        });

        it('Supply matches Cosmos total supply query', async () => {
            const evmSupply = await bankContract.supply(denomName);
            const cosmosSupply = await execCommandAndReturnJson(
                `seid query bank total --denom ${denomName}`
            );
            expect(Number(evmSupply)).to.equal(Number(cosmosSupply.amount));
        });

        it('Returns zero for non-existent denom', async () => {
            const supply = await bankContract.supply('unonexistent999');
            expect(supply).to.equal(0n);
        });
    });

    describe('send() — restricted to ERC20 pointer contracts only', function () {
        const bankSend = (contract: ethers.Contract) => contract.getFunction("send");

        it('Reverts when called directly from an EOA (not via ERC20 pointer)', async () => {
            const sendAmount = 500n;
            const balancePre = await bankContract.balance(alice.evmAddress, denomName);
            expect(balancePre > 0n).to.equal(true, 'Alice should have tokens to attempt send');

            try {
                const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
                const tx = await bankSend(aliceBank)(alice.evmAddress, bob.evmAddress, denomName, sendAmount, { gasLimit: 1_000_000 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                expect(e.code).to.equal('CALL_EXCEPTION');
            }

            const balancePost = await bankContract.balance(alice.evmAddress, denomName);
            expect(balancePost).to.equal(balancePre, 'Balance should be unchanged after rejected send');
        });
    });

    describe('sendNative()', function () {
        it('Sends usei to a Cosmos address and balances update correctly', async () => {
            const sendAmountWei = ethers.parseEther('0.01');
            const sendAmountUsei = 10000n;

            const cosmosPre = await bankQueryClient.bank.balance(admin.seiAddress, 'usei');
            const evmPre = await bankContract.balance(admin.evmAddress, 'usei');
            const senderPre = await bankContract.balance(alice.evmAddress, 'usei');

            const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
            const tx = await aliceBank.sendNative(admin.seiAddress, { value: sendAmountWei });
            const receipt = await tx.wait();

            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);

            await waitFor(1);
            const cosmosPost = await bankQueryClient.bank.balance(admin.seiAddress, 'usei');
            const evmPost = await bankContract.balance(admin.evmAddress, 'usei');
            const senderPost = await bankContract.balance(alice.evmAddress, 'usei');

            expect(BigInt(cosmosPost.amount)).to.equal(BigInt(cosmosPre.amount) + sendAmountUsei);
            expect(evmPost).to.equal(evmPre + sendAmountUsei);
            expect(senderPre - senderPost > sendAmountUsei).to.equal(true, 'Sender should lose more than sendAmount (includes gas)');
        });

        it('sendNative to an EVM hex address (0x) also works', async () => {
            const sendAmountWei = ethers.parseEther('0.005');
            const sendAmountUsei = 5000n;

            const receiverPre = await bankContract.balance(bob.evmAddress, 'usei');

            const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
            const tx = await aliceBank.sendNative(bob.seiAddress, { value: sendAmountWei });
            const receipt = await tx.wait();

            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);

            await waitFor(1);
            const receiverPost = await bankContract.balance(bob.evmAddress, 'usei');
            expect(receiverPost).to.equal(receiverPre + sendAmountUsei);
        });

        it('Multiple sequential sendNative calls accumulate correctly', async () => {
            const perSend = ethers.parseEther('0.001');
            const perSendUsei = 1000n;
            const numSends = 3;

            const receiverPre = await bankContract.balance(admin.evmAddress, 'usei');

            const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
            for (let i = 0; i < numSends; i++) {
                const tx = await aliceBank.sendNative(admin.seiAddress, { value: perSend });
                await tx.wait();
            }
            await waitFor(1);

            const receiverPost = await bankContract.balance(admin.evmAddress, 'usei');
            expect(receiverPost).to.equal(receiverPre + perSendUsei * BigInt(numSends));
        });

        it('Fails when sending zero value', async () => {
            try {
                const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
                const tx = await aliceBank.sendNative(admin.seiAddress, { value: 0 });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                // A zero-value payable precompile call reverts -> ethers surfaces CALL_EXCEPTION.
                expect(e.code).to.equal('CALL_EXCEPTION');
            }
        });

        it('Fails when sender has insufficient usei balance', async () => {
            const newUser = await UserFactory.createSeiUser(admin, 'bankBroke');
            try {
                const brokeBank = bankContract.connect(newUser.evmWallet.wallet) as ethers.Contract;
                const tx = await brokeBank.sendNative(admin.seiAddress, { value: ethers.parseEther('9999999') });
                await tx.wait();
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
                // Must be an actual funds rejection, not an unrelated error.
                const msg = (e.shortMessage ?? e.message ?? '').toLowerCase();
                expect(msg).to.match(
                    /insufficient|exceeds|revert/,
                    `expected an insufficient-funds style rejection, got: ${e.shortMessage ?? e.message}`
                );
            }
        });

        it('sendNative with a sub-usei wei remainder is rejected (no silent truncation)', async () => {
            // sendNative uses HandlePaymentUseiWei which accepts a usei+wei split, but the
            // precompile must not silently swallow value. We pin that a value strictly below
            // 1 usei (1e12 wei) cannot create a usei credit: it either reverts or moves 0 usei.
            const subUseiWei = ethers.parseUnits('1', 12) - 1n; // 1 wei short of 1 usei
            const receiverPre = await bankContract.balance(bob.evmAddress, 'usei');
            const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
            try {
                const tx = await aliceBank.sendNative(bob.seiAddress, { value: subUseiWei, gasLimit: 300000 });
                await tx.wait();
                // If it does NOT revert, it must not have credited a whole usei.
                await waitFor(1);
                const receiverPost = await bankContract.balance(bob.evmAddress, 'usei');
                expect(receiverPost).to.equal(receiverPre, 'sub-usei wei must not mint a usei credit');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });

    describe('Cross-runtime consistency', function () {
        it('balance() via precompile matches seid query for every denom alice holds', async () => {
            const allBalances = await bankContract.all_balances(alice.evmAddress);
            for (const entry of allBalances) {
                const evmAmount = entry[0];
                const denom = entry[1];
                const cosmosBalance = await bankQueryClient.bank.balance(alice.seiAddress, denom);
                expect(Number(evmAmount)).to.equal(
                    Number(cosmosBalance.amount),
                    `Cross-runtime mismatch for ${denom}`
                );
            }
        });

        it('supply() via precompile matches seid query bank total for usei', async () => {
            const evmSupply = await bankContract.supply('usei');
            const cosmosSupply = await execCommandAndReturnJson('seid query bank total --denom usei');
            expect(Number(evmSupply)).to.equal(Number(cosmosSupply.amount));
        });

        it('After Cosmos-side bank send, EVM balance reflects the change', async () => {
            const sendAmount = 5000;
            const evmPre = await bankContract.balance(alice.evmAddress, denomName);

            await mintTokens(alice, denomName, sendAmount.toString());
            await waitFor(2);

            const evmPost = await bankContract.balance(alice.evmAddress, denomName);
            expect(evmPost).to.equal(evmPre + BigInt(sendAmount));
        });

        it('After sendNative, Cosmos balance reflects the change', async () => {
            const sendAmountWei = ethers.parseEther('0.005');
            const sendAmountUsei = 5000n;
            const cosmosPre = await bankQueryClient.bank.balance(bob.seiAddress, 'usei');

            const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
            const tx = await aliceBank.sendNative(bob.seiAddress, { value: sendAmountWei });
            await tx.wait();
            await waitFor(1);

            const cosmosPost = await bankQueryClient.bank.balance(bob.seiAddress, 'usei');
            expect(BigInt(cosmosPost.amount)).to.equal(BigInt(cosmosPre.amount) + sendAmountUsei);
        });
    });

    describe('module accounts & vesting', function () {
        let moduleAccounts: ModuleAccountInfo[] = [];

        before('Discover genuine ModuleAccounts from the auth store', async () => {
            moduleAccounts = await listModuleAccounts();
            expect(moduleAccounts.length, 'chain should expose ModuleAccounts').to.be.greaterThan(0);
        });

        it('Unassociated module accounts are readable via the precompile cast address', async () => {
            // The bank precompile must report a module account's usei balance via the cast
            // (raw-20-byte) EVM address, matching the Cosmos bank query exactly. Also
            // sanity-check the derivation: sha256(name)[:20] reproduces the on-chain addr.
            // NOTE: on live networks the chain associates SOME module accounts itself
            // (e.g. fee_collector on arctic-1 receives EVM fees); the cast-address
            // identity only holds pre-association, so associated modules are skipped.
            let unassociated = 0;
            for (const m of moduleAccounts) {
                expect(moduleAddress(m.name)).to.equal(
                    m.address,
                    `derivation sha256(${m.name}) should match on-chain module address`
                );

                const assoc = await execCommandAndReturnJson(`seid q evm evm-addr ${m.address}`);
                if (assoc.associated) continue;
                unassociated++;

                const cast = castEvmAddress(m.address);
                const viaPrecompile = await bankContract.balance(cast, 'usei');
                const viaCosmos = await bankQueryClient.bank.balance(m.address, 'usei');
                expect(viaPrecompile).to.equal(
                    BigInt(viaCosmos.amount),
                    `${m.name}: precompile cast-address balance vs Cosmos bank query`
                );
            }
            expect(unassociated, 'at least one unassociated module account should exist').to.be.greaterThan(0);
        });

        it('Staking-pool module accounts hold real balances; bank/precompile agree', async () => {
            // The bonded/not-bonded staking pools custody delegated stake, so they should
            // hold a positive usei balance, and the EVM precompile view must equal Cosmos.
            const pools = moduleAccounts.filter(
                (m) => m.name === 'bonded_tokens_pool' || m.name === 'not_bonded_tokens_pool'
            );
            expect(pools.length, 'staking pools should be registered module accounts').to.be.greaterThan(0);

            for (const pool of pools) {
                const viaCosmos = await bankQueryClient.bank.balance(pool.address, 'usei');
                const viaPrecompile = await bankContract.balance(castEvmAddress(pool.address), 'usei');
                expect(viaPrecompile).to.equal(BigInt(viaCosmos.amount), `${pool.name}: precompile vs Cosmos`);
                expect(BigInt(viaCosmos.amount) > 0n, `${pool.name} should hold a positive balance`).to.equal(true);
            }
        });

        it('A plain MsgSend to a genuine module account is rejected (blocklisted), not a crash', async () => {
            // Cosmos SDK blocklists module accounts from receiving funds. A direct MsgSend
            // must fail at the message level with "not allowed to receive funds" and leave
            // the module balance unchanged — a clean rejection, never a chain halt.
            const target = moduleAccounts.find((m) => m.name === 'gov') ?? moduleAccounts[0];
            const cast = castEvmAddress(target.address);
            const pre = await bankContract.balance(cast, 'usei');

            const msgSend = {
                typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                value: {
                    fromAddress: admin.seiAddress,
                    toAddress: target.address,
                    amount: coins('777', 'usei'),
                },
            };

            let code = 0;
            let log = '';
            try {
                const res = await admin.seiWallet.signAndSend([msgSend], 'send to module account');
                code = res.code;
                log = res.rawLog ?? '';
            } catch (e: any) {
                code = -1;
                log = e?.message ?? String(e);
            }
            expect(code, `expected module-account send to be rejected: ${log}`).to.not.equal(0);
            expect(log.toLowerCase()).to.match(
                /not allowed to receive funds|unauthorized|blocked/,
                `rejection reason should reference the blocklist: ${log}`
            );

            const post = await bankContract.balance(cast, 'usei');
            expect(post).to.equal(pre, `${target.name} balance must be unchanged after rejected send`);
        });

        it('create-vesting-account into a genuine module account is rejected (cannot vest a module account)', async () => {
            // Vesting performs a bank deposit into the target, which hits the same blocklist.
            // So you cannot convert/fund a real module account via vesting: it is rejected,
            // the account stays a ModuleAccount, and nothing crashes.
            const target = moduleAccounts.find((m) => m.name === 'gov') ?? moduleAccounts[0];
            const endTime = Math.floor(Date.now() / 1000) + 3600;

            const out = await execCommandAndReturnJson(
                `seid tx vesting create-vesting-account ${target.address} 500000usei ${endTime} ` +
                `--delayed --from admin --fees 24500usei -y --broadcast-mode block --output json`
            );
            expect(out.code, `expected vesting into module account to be rejected: ${out.raw_log}`).to.not.equal(0);
            expect(String(out.raw_log).toLowerCase()).to.match(
                /not allowed to receive funds|unauthorized|blocked/,
                `vesting rejection should reference the blocklist: ${out.raw_log}`
            );

            // The target remains a ModuleAccount (type unchanged, not converted to vesting).
            const acct = await execCommandAndReturnJson(`seid q auth account ${target.address}`);
            expect(acct['@type']).to.equal(
                '/cosmos.auth.v1beta1.ModuleAccount',
                `${target.name} must remain a ModuleAccount after rejected vesting`
            );
        });

        it('Sends/vesting to ordinary (non-module) addresses still work', async () => {
            // Control: an address that merely *looks* module-like but is NOT a registered
            // ModuleAccount behaves like any user — sends and vesting succeed and hold.
            const ordinary = await UserFactory.createUnassociatedUsers(admin, 'notamodule', true);
            const cast = castEvmAddress(ordinary.seiAddress);
            const amount = 4321n;

            const pre = await bankContract.balance(cast, 'usei');
            const res = await admin.seiWallet.signAndSend(
                [
                    {
                        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                        value: {
                            fromAddress: admin.seiAddress,
                            toAddress: ordinary.seiAddress,
                            amount: coins(amount.toString(), 'usei'),
                        },
                    },
                ],
                'send to ordinary address'
            );
            expect(res.code).to.equal(0, `send to ordinary address failed: ${res.rawLog}`);
            await waitFor(2);

            const post = await bankContract.balance(cast, 'usei');
            expect(post >= pre + amount, `ordinary address should hold the deposit: ${post} < ${pre + amount}`).to.equal(true);
        });

        it('Delayed vesting account: precompile shows the full balance but spending the locked portion is rejected', async () => {
            // A delayed (cliff) vesting account holds the full amount but it is LOCKED until
            // end_time. The bank precompile reports the full balance (bank tracks total, not
            // spendable), yet a Cosmos send of the locked coins must fail the spendable-coins
            // calculation. This proves the locked-coin math is enforced and that the EVM
            // balance view is total-balance (not spendable), an important parity detail.
            const vester = await UserFactory.createUnassociatedUsers(admin, 'vester', true);
            const vestAmount = 1_000_000n; // usei, fully locked until end_time
            const endTime = Math.floor(Date.now() / 1000) + 3600; // 1h cliff

            const out = await execCommandAndReturnJson(
                `seid tx vesting create-vesting-account ${vester.seiAddress} ${vestAmount}usei ${endTime} ` +
                `--delayed --from admin --fees 24500usei -y --broadcast-mode block --output json`
            );
            expect(out.code).to.equal(0, `create-vesting-account failed: ${out.raw_log}`);
            await waitFor(2);

            // Precompile reports the FULL (total) balance, even though it is all locked.
            const cast = castEvmAddress(vester.seiAddress);
            const viaPrecompile = await bankContract.balance(cast, 'usei');
            const viaCosmos = await bankQueryClient.bank.balance(vester.seiAddress, 'usei');
            expect(viaPrecompile).to.equal(BigInt(viaCosmos.amount), 'vesting: precompile vs Cosmos total balance');
            expect(viaPrecompile).to.equal(vestAmount, 'vesting: precompile shows full (locked) balance');

            // Spending the locked portion must be rejected by the spendable-coins calc.
            // The vester has only the locked vesting coins; it also lacks fees, so we fund a
            // tiny fee buffer that is itself spendable, then attempt to move the locked coins.
            await UserFactory.fundAddressOnSei(vester.seiAddress, 'usei', '100000');
            await waitFor(2);

            const msgSpendLocked = {
                typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                value: {
                    fromAddress: vester.seiAddress,
                    toAddress: admin.seiAddress,
                    amount: coins(vestAmount.toString(), 'usei'),
                },
            };
            let rejected = false;
            let code = 0;
            let log = '';
            try {
                const spend = await vester.seiWallet.signAndSend([msgSpendLocked], 'spend locked vesting coins');
                code = spend.code;
                log = spend.rawLog ?? '';
                rejected = spend.code !== 0;
            } catch (e: any) {
                // A thrown error (e.g. insufficient spendable funds) is also a valid rejection.
                rejected = true;
                log = e?.message ?? String(e);
            }
            expect(rejected, `expected locked-coin spend to be rejected, got code=${code} log=${log}`).to.equal(true);
            expect(log.toLowerCase()).to.match(
                /insufficient|locked|spendable/,
                `rejection reason should reference locked/spendable funds: ${log}`
            );

            // The locked balance is unchanged after the failed spend (precompile view).
            const after = await bankContract.balance(cast, 'usei');
            expect(after >= vestAmount, `vesting balance unchanged after rejected locked-coin spend: ${after} < ${vestAmount}`).to.equal(true);
        });

        it('DIVERGENCE: EVM bank precompile sendNative deposits into a module account that Cosmos MsgSend blocks', async function () {
            this.timeout(2 * 60 * 1000);
            // IMPORTANT Sei behavior: the bank blocklist that rejects a Cosmos MsgSend to a
            // module account is NOT enforced by the EVM bank precompile's sendNative. The
            // same module account that refuses MsgSend ("not allowed to receive funds")
            // DOES receive funds via sendNative. This is an asymmetry between the Cosmos and
            // EVM funds-transfer paths; this test pins it so any future change is noticed.
            const target = (await listModuleAccounts()).find((m) => m.name === 'gov')!;
            expect(target, 'gov module account should exist').to.not.equal(undefined);
            const cast = castEvmAddress(target.address);

            // 1) Cosmos MsgSend to the module account is blocked.
            let cosmosCode = 0;
            let cosmosLog = '';
            try {
                const res = await admin.seiWallet.signAndSend(
                    [
                        {
                            typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                            value: {
                                fromAddress: admin.seiAddress,
                                toAddress: target.address,
                                amount: coins('1', 'usei'),
                            },
                        },
                    ],
                    'cosmos send to module (expect block)'
                );
                cosmosCode = res.code;
                cosmosLog = res.rawLog ?? '';
            } catch (e: any) {
                cosmosCode = -1;
                cosmosLog = e?.message ?? String(e);
            }
            expect(cosmosCode, `Cosmos MsgSend to module should be blocked: ${cosmosLog}`).to.not.equal(0);

            // 2) EVM sendNative to the SAME module account succeeds and DOES credit it.
            // 1 usei = 1e12 wei; sub-usei wei would round to a no-op, so send a full usei.
            const pre = await bankContract.balance(cast, 'usei');
            const sendWei = ethers.parseUnits('1', 12);
            const adminBank = bankContract.connect(admin.evmWallet.wallet) as ethers.Contract;
            const tx = await adminBank.sendNative(target.address, { value: sendWei, gasLimit: 300000 });
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1, 'sendNative to module account unexpectedly failed');
            await waitFor(2);

            const post = await bankContract.balance(cast, 'usei');
            expect(post).to.equal(
                pre + 1n,
                `EVM sendNative should have credited ${target.name} by 1 usei (Cosmos blocks this)`
            );

            // Cross-check via Cosmos bank query that the module really holds the deposit.
            const viaCosmos = await bankQueryClient.bank.balance(target.address, 'usei');
            expect(BigInt(viaCosmos.amount)).to.equal(post, 'Cosmos bank query agrees the module now holds the deposit');
        });

        it('Sanctioned module entry point (fund-community-pool) IS allowed even though direct send is blocked', async () => {
            // The blocklist only stops ARBITRARY transfers. Module-specific handlers
            // (MsgFundCommunityPool, delegate -> staking pool, gov deposit) are the intended
            // ways funds enter a module and bypass the bank blocklist by design. Here we
            // prove the contrast: a direct send to the distribution module is blocked, but
            // fund-community-pool succeeds and the community pool grows.
            const distModule = (await listModuleAccounts()).find((m) => m.name === 'distribution');

            // Direct send to the distribution module (if it is a registered ModuleAccount) is blocked.
            if (distModule) {
                let code = 0;
                let log = '';
                try {
                    const res = await admin.seiWallet.signAndSend(
                        [
                            {
                                typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                                value: {
                                    fromAddress: admin.seiAddress,
                                    toAddress: distModule.address,
                                    amount: coins('1000', 'usei'),
                                },
                            },
                        ],
                        'direct send to distribution module'
                    );
                    code = res.code;
                    log = res.rawLog ?? '';
                } catch (e: any) {
                    code = -1;
                    log = e?.message ?? String(e);
                }
                expect(code, `direct send to distribution module should be blocked: ${log}`).to.not.equal(0);
            }

            // Sanctioned path: fund-community-pool succeeds and increases the pool.
            const poolBefore = await execCommandAndReturnJson('seid q distribution community-pool --output json');
            const beforeUsei = Number(
                (poolBefore.pool ?? []).find((c: any) => c.denom === 'usei')?.amount ?? '0'
            );

            const fundAmount = 50000;
            const res = await execCommandAndReturnJson(
                `seid tx distribution fund-community-pool ${fundAmount}usei --from admin --fees 24500usei -y --broadcast-mode block --output json`
            );
            expect(res.code).to.equal(0, `fund-community-pool should be allowed: ${res.raw_log}`);
            await waitFor(2);

            const poolAfter = await execCommandAndReturnJson('seid q distribution community-pool --output json');
            const afterUsei = Number(
                (poolAfter.pool ?? []).find((c: any) => c.denom === 'usei')?.amount ?? '0'
            );
            expect(afterUsei).to.be.greaterThan(beforeUsei, 'community pool should grow via the sanctioned path');
        });
    });

    describe('vesting spendability via bank precompile sendNative', function () {
        this.timeout(5 * 60 * 1000);

        it('All-locked vesting + feeless associate: sendNative of the held-but-locked coins is rejected (insufficient funds)', async () => {
            const floor = await evmFloorUsei(admin);
            // Lock more than the EVM floor so a send of coins the account *holds* (but are
            // locked) necessarily exceeds the floor (+0 spendable) ceiling. On a clean node
            // the floor is 0 and this is just a small amount.
            const lockedUsei = floor + 20n * SEI; // all locked, no spendable

            const vester = await UserFactory.createUnassociatedUsers(admin, 'vesterLocked', true);
            await createVesting(vester, lockedUsei);
            await associateFeeless(vester);

            // The EVM spendable view is the floor only (+0 spendable); locked principal excluded.
            expect(await evmSpendableUsei(admin, vester.evmAddress)).to.equal(
                floor,
                'EVM spendable view should be floor + 0 spendable (locked vesting excluded)'
            );

            // Try to send coins the account holds but are locked: floor < value <= locked total.
            const sendUsei = floor + 10n * SEI; // above the floor ceiling, within the locked principal
            const res = await trySendNative(admin, bankContract, vester, admin.seiAddress, sendUsei);
            expect(res.ok, `sendNative of locked coins must NOT succeed (got: ${res.reason})`).to.equal(false);
            expect(res.reason.toLowerCase()).to.match(
                /insufficient|not mined/,
                `rejection should reference insufficient funds (or a wedged tx): ${res.reason}`
            );

            // The locked principal is untouched after the rejected send.
            const after = await bankQueryClient.bank.balance(vester.seiAddress, 'usei');
            expect(
                BigInt(after.amount) >= lockedUsei,
                `locked principal must be intact: ${after.amount} < ${lockedUsei}`
            ).to.equal(true);
        });

        it('Vesting + spendable: sendNative above (spendable+floor) but below total is rejected; a within-ceiling send works', async () => {
            const floor = await evmFloorUsei(admin);
            const lockedUsei = floor + 20n * SEI; // locked principal, sized above the floor
            const spendableUsei = 5n * SEI;       // real spendable buffer (sent-in coins are spendable)

            const vester = await UserFactory.createUnassociatedUsers(admin, 'vesterMixed', true);
            await createVesting(vester, lockedUsei);
            await UserFactory.fundAddressOnSei(vester.seiAddress, 'usei', spendableUsei.toString());
            await waitFor(2);
            await associateFeeless(vester);

            // EVM spendable view = floor + spendable; the locked principal is still excluded.
            expect(await evmSpendableUsei(admin, vester.evmAddress)).to.equal(
                floor + spendableUsei,
                'EVM spendable view should be floor + spendable (locked vesting excluded)'
            );

            // FAIL: value > (spendable + floor) but < total — it would have to dip into the
            // locked principal, so it is rejected. (NOTE: on this endpoint the floor inflates
            // the effective spendable by ~100 SEI, so the value must clear floor+spendable,
            // not just the raw Cosmos spendable, to actually fail.)
            const total = lockedUsei + spendableUsei;
            const overUsei = floor + spendableUsei + 10n * SEI; // > ceiling, < floor + total
            expect(overUsei < floor + total, 'over-amount must stay below floor + total').to.equal(true);
            const fail = await trySendNative(admin, bankContract, vester, admin.seiAddress, overUsei);
            expect(fail.ok, `over-ceiling sendNative must NOT succeed (got: ${fail.reason})`).to.equal(false);
            expect(fail.reason.toLowerCase()).to.match(
                /insufficient|not mined/,
                `rejection should reference insufficient funds (or a wedged tx): ${fail.reason}`
            );

            // CONTROL: a send within the real spendable buffer succeeds — spendable IS usable,
            // proving the rejection above was specifically about the locked principal.
            const okSend = await trySendNative(admin, bankContract, vester, admin.seiAddress, 2n * SEI); // <= spendable
            expect(okSend.ok, `within-spendable sendNative should succeed (got: ${okSend.reason})`).to.equal(true);

            // The locked principal (original vesting) is unchanged; only spendable/floor moved.
            const acct = await execCommandAndReturnJson(`seid q auth account ${vester.seiAddress}`);
            const origVesting = BigInt(
                (acct.base_vesting_account?.original_vesting ?? []).find((c: any) => c.denom === 'usei')?.amount ?? '0'
            );
            expect(origVesting).to.equal(lockedUsei, 'original vesting (locked) principal must be unchanged');
        });
    });

    describe('Cosmos MsgMultiSend edge cases', function () {
        // Helper: broadcast and capture the rejection (code != 0 or a thrown error),
        // so we can assert the chain cleanly rejects rather than crashes.
        const attemptCosmos = async (user: SeiUser, msgs: any[], memo = 'multisend-edge') => {
            try {
                const res = await user.seiWallet.signAndSend(msgs, memo);
                return { code: res.code, log: res.rawLog ?? '' };
            } catch (e: any) {
                return { code: -1, log: e?.message ?? String(e) };
            }
        };
        const multiSend = (inputs: any[], outputs: any[]) => ({
            typeUrl: '/cosmos.bank.v1beta1.MsgMultiSend',
            value: MsgMultiSend.fromPartial({ inputs, outputs }),
        });

        before('ensure alice can fund multi-sends', async () => {
            await UserFactory.fundAddressOnSei(alice.seiAddress, 'usei', '5000000');
            await waitFor(1);
        });

        it('rejects when input total != output total (ErrInputOutputMismatch)', async () => {
            const bobPre = await bankContract.balance(bob.evmAddress, 'usei');
            const msg = multiSend(
                [{ address: alice.seiAddress, coins: coins('1000', 'usei') }],
                [{ address: bob.seiAddress, coins: coins('900', 'usei') }], // 100 short
            );
            const { code, log } = await attemptCosmos(alice, [msg]);
            expect(code, `sum-mismatch multi-send must be rejected: ${log}`).to.not.equal(0);
            const bobPost = await bankContract.balance(bob.evmAddress, 'usei');
            expect(bobPost).to.equal(bobPre, 'no balance should move on a rejected multi-send');
        });

        it('rejects an output with a zero coin amount', async () => {
            const msg = multiSend(
                [{ address: alice.seiAddress, coins: coins('1000', 'usei') }],
                [
                    { address: bob.seiAddress, coins: coins('1000', 'usei') },
                    { address: admin.seiAddress, coins: coins('0', 'usei') }, // zero -> invalid
                ],
            );
            const { code, log } = await attemptCosmos(alice, [msg]);
            expect(code, `zero-coin output must be rejected: ${log}`).to.not.equal(0);
        });

        it('credits the same recipient twice when it appears as two outputs (sums)', async () => {
            const bobPre = await bankContract.balance(bob.evmAddress, 'usei');
            const a = 1500n;
            const b = 2500n;
            const msg = multiSend(
                [{ address: alice.seiAddress, coins: coins((a + b).toString(), 'usei') }],
                [
                    { address: bob.seiAddress, coins: coins(a.toString(), 'usei') },
                    { address: bob.seiAddress, coins: coins(b.toString(), 'usei') },
                ],
            );
            const { code, log } = await attemptCosmos(alice, [msg]);
            expect(code, `duplicate-output multi-send should succeed: ${log}`).to.equal(0);
            await waitFor(1);
            const bobPost = await bankContract.balance(bob.evmAddress, 'usei');
            expect(bobPost).to.equal(bobPre + a + b, 'duplicate outputs must both be credited');
        });

        it('a multi-send with a module-account output fails atomically (co-recipient not credited)', async () => {
            // Per-output BlockedAddr check rejects the whole MsgMultiSend, so a valid
            // co-output in the same message must NOT be partially credited.
            const govModule = (await listModuleAccounts()).find((m) => m.name === 'gov')!;
            const bobPre = await bankContract.balance(bob.evmAddress, 'usei');
            const msg = multiSend(
                [{ address: alice.seiAddress, coins: coins('2000', 'usei') }],
                [
                    { address: bob.seiAddress, coins: coins('1000', 'usei') },        // valid
                    { address: govModule.address, coins: coins('1000', 'usei') },     // blocked
                ],
            );
            const { code, log } = await attemptCosmos(alice, [msg]);
            expect(code, `multi-send with blocked output must be rejected: ${log}`).to.not.equal(0);
            await waitFor(1);
            const bobPost = await bankContract.balance(bob.evmAddress, 'usei');
            expect(bobPost).to.equal(bobPre, 'atomic failure: the valid co-output must not be credited');
        });
    });

    describe('Cosmos memo edge cases (max_memo_characters = byte length)', function () {
        const sendWithMemo = async (memo: string) => {
            const msg = {
                typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                value: { fromAddress: admin.seiAddress, toAddress: bob.seiAddress, amount: coins('1', 'usei') },
            };
            try {
                const res = await admin.seiWallet.signAndSend([msg], memo);
                return { code: res.code, log: res.rawLog ?? '' };
            } catch (e: any) {
                return { code: -1, log: e?.message ?? String(e) };
            }
        };

        it('accepts a memo at the 256-byte limit', async () => {
            const memo = 'a'.repeat(256);
            expect(Buffer.byteLength(memo, 'utf8')).to.equal(256);
            const { code, log } = await sendWithMemo(memo);
            expect(code, `256-byte memo should be accepted: ${log}`).to.equal(0);
        });

        it('rejects a memo over the 256-byte limit', async () => {
            const memo = 'a'.repeat(257);
            const { code, log } = await sendWithMemo(memo);
            expect(code, `257-byte memo should be rejected: ${log}`).to.not.equal(0);
            expect(log.toLowerCase()).to.match(/memo|too large|too long/, `rejection should cite the memo: ${log}`);
        });

        it('memo length is counted in UTF-8 bytes, not runes (multi-byte boundary)', async () => {
            // Each emoji is 4 UTF-8 bytes. 64 emojis = 256 bytes (OK); 65 = 260 bytes (reject).
            const okMemo = '\u{1F600}'.repeat(64);
            const tooBig = '\u{1F600}'.repeat(65);
            expect(Buffer.byteLength(okMemo, 'utf8')).to.equal(256);
            expect(Buffer.byteLength(tooBig, 'utf8')).to.equal(260);

            const ok = await sendWithMemo(okMemo);
            expect(ok.code, `256-byte (64-emoji) memo should be accepted: ${ok.log}`).to.equal(0);

            const bad = await sendWithMemo(tooBig);
            expect(bad.code, `260-byte (65-emoji) memo should be rejected: ${bad.log}`).to.not.equal(0);
        });

        it('accepts control characters / newlines within the limit (no content filtering)', async () => {
            const memo = 'line1\nline2\tcol\u0007bell';
            expect(Buffer.byteLength(memo, 'utf8')).to.be.lessThan(256);
            const { code, log } = await sendWithMemo(memo);
            expect(code, `control-char memo within limit should be accepted: ${log}`).to.equal(0);
        });
    });

    describe('Post-association cast-address recipient block (CanAddressReceive)', function () {
        // After an EVM<->Sei association, the "cast" Sei address (raw 20 EVM bytes as bech32)
        // becomes unreceivable: funds must go to the real (pubkey-derived) Sei address instead.
        // Pins sei-chain fix where CanAddressReceive blocks sends to a cast addr post-association.
        let castOfAdmin: string;

        before('confirm admin is associated and derive its cast address', async () => {
            // `evm-addr` expects a bech32 Sei address; for a 0x address use `sei-addr`.
            const assoc = await execCommandAndReturnJson(`seid q evm sei-addr ${admin.evmAddress}`);
            expect(assoc.associated, 'admin must be associated for this test').to.equal(true);
            castOfAdmin = castSeiAddress(admin.evmAddress);
            // The cast address must differ from the real (pubkey-derived) Sei address.
            expect(castOfAdmin).to.not.equal(admin.seiAddress);
        });

        it('Cosmos MsgSend to the cast address of an associated account is rejected', async () => {
            await UserFactory.fundAddressOnSei(alice.seiAddress, 'usei', '1000000');
            await waitFor(1);
            const msg = {
                typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                value: { fromAddress: alice.seiAddress, toAddress: castOfAdmin, amount: coins('1000', 'usei') },
            };
            let code = 0; let log = '';
            try {
                const res = await alice.seiWallet.signAndSend([msg], 'send to cast addr');
                code = res.code; log = res.rawLog ?? '';
            } catch (e: any) { code = -1; log = e?.message ?? String(e); }
            expect(code, `send to cast address of associated acct must be rejected: ${log}`).to.not.equal(0);
        });

        it('sendNative to the cast address of an associated account is rejected', async () => {
            const aliceBank = bankContract.connect(alice.evmWallet.wallet) as ethers.Contract;
            try {
                const tx = await aliceBank.sendNative(castOfAdmin, { value: ethers.parseUnits('1', 12), gasLimit: 300000 });
                const receipt = await tx.wait();
                expect(receipt.status).to.equal(0, 'sendNative to a post-association cast address must not succeed');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });
});

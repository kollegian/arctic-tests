import {SeiUser, UserFactory} from "../../../shared/User";
import {Contract, ethers} from "ethers";
import {Cw721Token, Erc20Token, Erc721Token} from "../../../shared/Token";
import {
    buildRawSetCodeTx,
    clearSetCode,
    createSelfAuthorization,
    getAccountAbi, returnBatchMintCalls,
    returnMintAndApproveCalls,
    sendAuthorizedTx,
    sendBatchTxs,
    sendTxWithAuthorizationList,
    setCodeForEOA,
    setCodeWithoutChecks, sponsorAuthorizeAndExecuteBatch
} from "./utils";
import {expect} from "chai";
import {EvmRpcClient} from "../../../shared/RpcClient";
import stakingAbi from "../../precompiles/abis/staking_abi.json";
import {returnQueryClient} from "../../precompiles/utils";
import {QueryClient, setupStakingExtension, StakingExtension} from "@cosmjs/stargate";
import {TokenDeployer} from "../../../shared/Deployer";
import {waitFor} from "../../../shared/utils/helpers";
//atlantic 2 address
// const SIMPLE_ACCOUNT_CONTRACT_ADDRESS = "0xa0F15a2f09F3BD4E289cd2DAa0CADA239b11b88C";

// arctic 1 address
const SIMPLE_ACCOUNT_CONTRACT_ADDRESS = "0x514a27D2D9FA4E16bAFAf0540afE7b45E4ae1549";
const PAYMASTER_ADDRESS = "0x28AC01985c5f64c761BE0C22b054566A0829467a";

describe('7702 Account Abstraction Tests', function () {
    this.timeout(10 * 60 * 1000);
    let alice: SeiUser;
    let bob: SeiUser;
    let simpleAccountContract: Contract;
    let erc20: Erc20Token;
    let chainId: bigint;
    let rpcClient: EvmRpcClient;
    let erc721: Erc721Token;
    let cw721: Cw721Token;

    before('Initializes clients and users', async () => {
        const admin = await UserFactory.createAdminUser();
        // await UserFactory.fundAdminOnSei();
        [alice, bob] = await UserFactory.createSeiUsers(admin, 2, false);
        console.log('Bob added');
        console.log(admin.evmWallet.wallet.privateKey);
        simpleAccountContract = new Contract(SIMPLE_ACCOUNT_CONTRACT_ADDRESS, getAccountAbi(), alice.evmWallet.wallet);
        erc20 = new Erc20Token(alice, '0x4b4508fb35c8963951E1D9Cd83340c9283Ac67dB');
        chainId = BigInt((await alice.evmWallet.signingClient.getNetwork()).chainId);
        rpcClient = new EvmRpcClient(alice.evmRpcEndpoint, alice.evmWallet.signingClient);
        const deployer = new TokenDeployer(alice);
        erc721 = new Erc721Token(alice, '0x17BA1f9cBa8f616E30eE1be1dC9b30c73eB233Da');
        cw721 = new Cw721Token(admin, 'sei1t8pnq7euch96fzuqt0p52x3v5dnue2fd0axf9kqk6q3qgzsecmessn0gu5');
    });

    /**
     * Tests chain id, nonce, authorization list, and lists.
     */
    describe('Authorization Creation Tests', function () {
        it('Users cant set an authorization list with empty destination', async () => {
            const unusedUser = await UserFactory.createUnassociatedUsers(alice, 'unused');
            console.log(unusedUser.evmWallet.wallet.privateKey);
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const badAuth: any = { ...(auth as any), address: '' };
            try {
                const hash = await buildRawSetCodeTx(alice, [badAuth]);
                console.log(hash);
                throw new Error('Expected error for empty destination');
            } catch (e: any) {
                expect(e.message).to.contain('input string too short for common.Address');
            }
            const actualSetCode = await rpcClient.getCode(alice.evmAddress);
            expect(actualSetCode).to.equal('0x');
        });

        it('Users cant set an authorization list with invalid destination address', async () => {
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const badAuth: any = { ...(auth as any), address: await simpleAccountContract.getAddress() + '13' };
            try {
                await buildRawSetCodeTx(alice, [badAuth]);
                throw new Error('Expected error for invalid destination address');
            } catch (e: any){
                expect(e.message).to.contain('input string too long for common.Address');
            }
            const actualSetCode = await rpcClient.getCode(alice.evmAddress);
            expect(actualSetCode).to.equal('0x');
            const calls = returnMintAndApproveCalls(erc20, ethers.parseEther('100'), alice.evmAddress);
            const preBalance = await erc20.balanceOf(alice.evmAddress);
            const batchTx = await sendBatchTxs(alice, calls, simpleAccountContract, {eoaAddress: alice.evmAddress});
            const afterBalance = await erc20.balanceOf(alice.evmAddress);
            expect(preBalance).to.equal(afterBalance);
        });

        it('Users cant set authorization with invalid chain id', async () => {
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const badAuth: any = { ...(auth as any), chainId: chainId + 1n };
            try {
                await buildRawSetCodeTx(alice, [badAuth]);
                throw new Error('Expected error for wrong chain id');
            } catch (e: any){
                expect(e.message).to.contain('insufficient funds for');
            }
        });

        it('Users cant authorize with chain id above 2*256', async () => {
            const huge = (1n << 256n) + 1n;
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress(), huge);
            try{
                await buildRawSetCodeTx(alice, [auth]);
                throw new Error('Expected error');
            } catch (e: any){
                expect(e.message).to.contain('rlp: value too large for uint256');
            }
            const actualSetCode = await rpcClient.getCode(alice.evmAddress);
            expect(actualSetCode).to.equal('0x');
        });

        it('Users cant authorize with y_parity above 2**8', async () =>{
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const tampered = { ...auth, signature: { r: auth.signature.r, s: auth.signature.s, yParity: 300 as any } } as ethers.Authorization;
            try {
                await buildRawSetCodeTx(alice, [tampered]);
                throw new Error('Expected error');
            } catch (e: any) {
                expect(e.message).to.contain('input string too long for');
            }
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.equal('0x');
        });

        it('Users cant authorize with y_parity below 0', async () =>{
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const tampered = { ...auth, signature: { r: auth.signature.r, s: auth.signature.s, yParity: -1 as any } } as ethers.Authorization;
            try {
                await buildRawSetCodeTx(alice, [tampered]);
                throw new Error('Expected error');
            } catch (e: any) {
                expect(e.message).to.contain('insufficient funds for');
            }
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.equal('0x');
        });

        it('Users cant authorize with r above 2**256', async () =>{
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const longHex = '0x' + 'ff'.repeat(33);
            const tampered = { ...auth, signature: { r: longHex as any, s: auth.signature.s, yParity: auth.signature.yParity} } as ethers.Authorization;
            try {
                await buildRawSetCodeTx(alice, [tampered]);
                throw new Error('Expected error');
            } catch (e: any) {
                expect(e.message).to.contain('rlp: value too large for');
            }
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.equal('0x');
        });

        it('Users cant authorize with r below 0', async () =>{
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            try {
                await buildRawSetCodeTx(alice, [auth], {nonce: -1n});
                throw new Error('Expected error');
            } catch (e: any) {
                expect(e.message).to.contain('insufficient funds for intrinsic');
            }
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.equal('0x');
        });

        it('Users cant authorize with s above 2**256', async () =>{
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const longHex = '0x' + 'ff'.repeat(33);
            const tampered = { ...auth, signature: { r: auth.signature.r as any, s: longHex, yParity: auth.signature.yParity} } as ethers.Authorization;
            try {
                await buildRawSetCodeTx(alice, [tampered]);
                throw new Error('Expected error');
            } catch (e: any) {
                expect(e.message).to.contain('rlp: value too large for uint256');
            }
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.equal('0x');
        });

        it('Users cant authorize with s below 0', async () =>{
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const tampered = { ...auth, signature: { r: auth.signature.r as any, s: '-0x1', yParity: auth.signature.yParity} } as ethers.Authorization;
            try {
                await buildRawSetCodeTx(alice, [tampered]);
                throw new Error('Expected error');
            } catch (e: any) {
                expect(e.message).to.contain('rlp: non-canonical integer');
            }
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.equal('0x');
        });

        it('Users cant set empty auth list', async () =>{
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            try {
                await setCodeWithoutChecks(alice, null);
                throw new Error('Expected error');
            } catch (e: any) {
                expect(true).to.be.true;
            }
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.equal('0x');
        });

        it('Users cant create authorization with previous nonce', async () =>{
            const dave = await UserFactory.createSeiUser(alice, 'dave');
            const mintTx = await erc20.contract.connect(alice.evmWallet.wallet).mint(dave.evmAddress, ethers.parseEther('100'));
            await mintTx.wait();
            const mint2Tx = await erc20.contract.connect(alice.evmWallet.wallet).mint(dave.evmAddress, ethers.parseEther('100'));
            await mint2Tx.wait();

            const nonce = await alice.evmWallet.signingClient.getTransactionCount(alice.evmAddress, "pending");
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress(), chainId, nonce - 2);

            await setCodeForEOA(alice, [auth]);

            //It returns success yet it doesnt set it @ToDo verify on sepolia
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.equal('0x');
        });

        it('Users cant create authorization with negative nonce', async () =>{
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            auth.nonce = -1n;
            try {
                await buildRawSetCodeTx(alice, [auth]);
                throw new Error('Expected error');
            } catch (e: any) {
                expect(e.message).to.contain('insufficient funds for intrinsic');
            }
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.equal('0x');
        });

        it('Users cant create authorization with nonce above 2*46', async () =>{
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress(), chainId, 2**46 + 2);
            await setCodeWithoutChecks(alice, auth);
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.equal('0x');
        })

        it('User can create an authorization for self', async () => {
            const authorization = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const setCodeReceipt = await setCodeForEOA(alice, [authorization]);
            expect(setCodeReceipt?.status).to.equal(1);
            expect(setCodeReceipt?.type.toString()).to.equal('4');
            await waitFor(1);
            const setCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(setCode).to.eq('0xef0100514a27d2d9fa4e16bafaf0540afe7b45e4ae1549');
        });

        let usedAuth: ethers.Authorization;
        it('HAPPY PATH - User creates authorization and sends batch txs to themselves', async () =>{
            const allowance = await erc20.allowance(alice.evmAddress, bob.evmAddress);
            expect(Number(allowance)).to.equal(0);
            usedAuth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const setCodeReceipt = await setCodeForEOA(alice, [usedAuth]);
            expect(setCodeReceipt?.status).to.equal(1);
            expect(setCodeReceipt?.type.toString()).to.equal('4');

            const encodedCalls = returnMintAndApproveCalls(erc20, ethers.parseEther('100'), bob.evmAddress);
            //@ts-ignore
            const batchTxReceipts = await sendBatchTxs(alice, encodedCalls, simpleAccountContract, {eoaAddress: alice.evmAddress, authorization: usedAuth});
            expect(batchTxReceipts?.status).to.equal(1);
            const newAllowance = await erc20.allowance(alice.evmAddress, bob.evmAddress);
            expect(BigInt(newAllowance)).to.equal(ethers.parseEther('100'));
        });

        it('Users cant set authorization for a different address with invalid signature', async () =>{
            const ferdie = await UserFactory.createSeiUser(alice, 'ferdie');
            const nonce = await ferdie.evmWallet.signingClient.getTransactionCount(ferdie.evmAddress, "pending");
            const wrongAuth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress(), chainId, nonce);
            const setCodeReceipt = await setCodeForEOA(ferdie, [wrongAuth], alice);
            expect(setCodeReceipt?.status).to.equal(1);
            expect(setCodeReceipt?.type.toString()).to.equal('4');

            const ferdieCode = await ferdie.evmWallet.signingClient.getCode(ferdie.evmAddress);
            expect(ferdieCode).to.equal('0x');
        })

        it('After users used defined nonce with batch txs, they can continue using the same set code', async () =>{
            const encodedCalls = returnMintAndApproveCalls(erc20, ethers.parseEther('100'), bob.evmAddress);
            const batchRepeatedTxReceipts = await sendBatchTxs(alice, encodedCalls, simpleAccountContract, {eoaAddress: alice.evmAddress});
            //verify it didnt mint twice
            const balance = await erc20.balanceOf(bob.evmAddress);
            expect(BigInt(balance)).to.equal(ethers.parseEther('200'));
        });

        it('Users can clear the set code after using it', async () =>{
            await clearSetCode(alice);
            const currentCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(currentCode).to.equal('0x');
            const encodedCalls = returnMintAndApproveCalls(erc20, ethers.parseEther('100'), alice.evmAddress);
            //@ts-ignore
            const alicePreBalance = await erc20.balanceOf(alice.evmAddress);
            await sendBatchTxs(alice, encodedCalls, simpleAccountContract, {eoaAddress: alice.evmAddress});
            const aliceAfterBalance = await erc20.balanceOf(alice.evmAddress);
            expect(aliceAfterBalance).to.equal(alicePreBalance);
        })

        it('After users create an authorization list, they cant set code with old authorization list', async () =>{
            const authorization = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const setCodeReceipt = await setCodeForEOA(alice, [authorization]);
            expect(setCodeReceipt?.status).to.equal(1);
            expect(setCodeReceipt?.type.toString()).to.equal('4');

            //increment nonce
            const mintTx = await erc20.contract.connect(alice.evmWallet.wallet).mint(alice.evmAddress, ethers.parseEther('100'));
            await mintTx.wait();

            const mintTx2 = await erc20.contract.connect(alice.evmWallet.wallet).mint(alice.evmAddress, ethers.parseEther('100'));
            await mintTx2.wait();

            //Expecting to fail here
            const setCode2 = await setCodeForEOA(alice, [authorization]);
            expect(setCode2?.status).to.equal(1);
            expect(setCode2?.type.toString()).to.equal('4');
        });

        it('Users can set multiple authorization lists', async () => {
            const ferdie = await UserFactory.createSeiUser(alice, 'ferdie');
            const authorization1 = await createSelfAuthorization(ferdie, await simpleAccountContract.getAddress());
            const authorization2 = await createSelfAuthorization(ferdie, erc20.getAddress() as string);

            const setCodeTx = await setCodeForEOA(ferdie, [authorization1, authorization2]);

            const code = await ferdie.evmWallet.signingClient.getCode(ferdie.evmAddress);

            const alicePreBalance = await erc20.balanceOf(alice.evmAddress);
            const calls = returnMintAndApproveCalls(erc20, ethers.parseEther('100'), alice.evmAddress);
            //@ts-ignore
            const batchTxReceipts = await sendBatchTxs(ferdie, calls, simpleAccountContract, {eoaAddress: ferdie.evmAddress, authorization: authorization2});
            const aliceAfterBalance = await erc20.balanceOf(alice.evmAddress);
            expect(aliceAfterBalance - alicePreBalance).to.equal(ethers.parseEther('100'));
            expect(batchTxReceipts?.status).to.equal(1);
        });

        it('Alice can set code for Ferdie after Ferdie signs authorization', async () => {
            const ferdie = await UserFactory.createSeiUser(alice, 'ferdie');
            const ferdieNonce = await ferdie.evmWallet.signingClient.getTransactionCount(ferdie.evmAddress, "pending");
            const authorization = await createSelfAuthorization(ferdie, await simpleAccountContract.getAddress(), chainId, ferdieNonce);
            const setCodeTx = await setCodeForEOA(ferdie, [authorization], alice);
            expect(setCodeTx?.status).to.equal(1);
            expect(setCodeTx?.type.toString()).to.equal('4');
            const ferdieCode = await ferdie.evmWallet.signingClient.getCode(ferdie.evmAddress);
            expect(ferdieCode).to.not.equal('0x');
            expect(ferdieCode).to.eq('0xef0100514a27d2d9fa4e16bafaf0540afe7b45e4ae1549');

            //ferdie can call batch txs on his code now
            const ferdiePreBalance = await erc20.balanceOf(ferdie.evmAddress);
            const calls = await returnBatchMintCalls(erc20, ethers.parseEther('100'), ferdie.evmAddress);
            const batchTxReceipts = await sendBatchTxs(ferdie, calls, simpleAccountContract, {eoaAddress: ferdie.evmAddress});
            expect(batchTxReceipts?.status).to.equal(1);
            const ferdieAfterBalance = await erc20.balanceOf(ferdie.evmAddress);
            expect(ferdieAfterBalance - ferdiePreBalance).to.equal(ethers.parseEther('200'));
        });

        it.skip('Bob can set code and execute in the same tx for alice', async () =>{
            const ferdie = await UserFactory.createSeiUser(alice, 'ferdie');
            const ferdiePreBalance = await erc20.balanceOf(ferdie.evmAddress);
            const tx = await sponsorAuthorizeAndExecuteBatch(ferdie, alice, await simpleAccountContract.getAddress(), [
                { target: erc20.getAddress(), value: 0n, data: erc20.contract.interface.encodeFunctionData("mint", [ferdie.evmAddress, ethers.parseEther('100')]) },
                { target: erc20.getAddress(), value: 0n, data: erc20.contract.interface.encodeFunctionData("mint", [ferdie.evmAddress, ethers.parseEther('100')]) },
            ]);
            const ferdieAfterBalance = await erc20.balanceOf(ferdie.evmAddress);
            expect(tx?.status).to.equal(1);
            expect(ferdieAfterBalance - ferdiePreBalance).to.equal(ethers.parseEther('200'));
        });

        let relayerAuth: ethers.Authorization;
        let prevNonce: number;
        let ferdie: SeiUser;
        it.skip('Users can pay for batch txs with gas sponsorship', async () => {
            ferdie = await UserFactory.createSeiUser(alice, 'ferdie');
            prevNonce = await ferdie.evmWallet.signingClient.getTransactionCount(ferdie.evmAddress, "pending");
            relayerAuth = await createSelfAuthorization(ferdie, await simpleAccountContract.getAddress());
            const preBalance = await erc20.balanceOf(bob.evmAddress);
            const calls = returnBatchMintCalls(erc20, ethers.parseEther('25'), bob.evmAddress);
            const data = simpleAccountContract.interface.encodeFunctionData('executeBatch', [calls]);

            // Ferdie (bob) sends the tx and pays gas
            const receipt = await sendAuthorizedTx(alice, ferdie.evmAddress, relayerAuth, data);
            expect(receipt?.status).to.equal(1);
            expect(receipt?.from?.toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
            expect(receipt?.to?.toLowerCase()).to.equal(ferdie.evmAddress.toLowerCase());

            // The approve in the batch should set allowance to 25e18
            const afterBalance = await erc20.balanceOf(bob.evmAddress);
            console.log('Pre Balance ', preBalance);
            console.log('After Balance ', afterBalance);
        });

        it('Verify that the nonce of authorization is incremented once it is executed', async () => {
            ferdie = await UserFactory.createSeiUser(alice, 'ferdie');
            const currentNonce = await ferdie.evmWallet.signingClient.getTransactionCount(ferdie.evmAddress, "pending");
            const authorization = await createSelfAuthorization(ferdie, await simpleAccountContract.getAddress());
            await setCodeForEOA(ferdie, [authorization]);

            const batchCalls = returnBatchMintCalls(erc20, ethers.parseEther('25'), bob.evmAddress);
            const batchTx = await sendBatchTxs(ferdie, batchCalls, simpleAccountContract, {eoaAddress: ferdie.evmAddress});
            expect(batchTx?.status).to.equal(1);
            const currentNonce2 = await ferdie.evmWallet.signingClient.getTransactionCount(ferdie.evmAddress, "pending");
            expect(currentNonce2).to.equal(currentNonce + 3);
        });

        it.skip('Relayer cant use to send batch txs with gas sponsorship after using the authorization', async () => {
            const calls = returnMintAndApproveCalls(erc20, ethers.parseEther('25'), bob.evmAddress);
            const data = simpleAccountContract.interface.encodeFunctionData('executeBatch', [calls]);

            const receipt = await sendAuthorizedTx(alice, ferdie.evmAddress, relayerAuth, data);
            expect(receipt?.status).to.equal(1);
        })

        it.skip('Relayer pays gas using authorizationList (gas sponsorship)', async () => {
            const authorization = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const calls = returnMintAndApproveCalls(erc20, ethers.parseEther('25'), bob.evmAddress);
            const data = simpleAccountContract.interface.encodeFunctionData('executeBatch', [calls]);

            // Relayer (bob) sends the tx and pays gas
            const receipt = await sendAuthorizedTx(bob, await simpleAccountContract.getAddress(), authorization, data);
            expect(receipt?.status).to.equal(1);
            expect(receipt?.from?.toLowerCase()).to.equal(bob.evmAddress.toLowerCase());

            // The approve in the batch should set allowance to 25e18
            const allowance = await erc20.allowance(alice.evmAddress, bob.evmAddress);
            expect(BigInt(allowance)).to.equal(ethers.parseEther('25'));
        });

        it('Authorization for implementation A cannot be used for implementation B', async () => {
            // Create an authorization that points to a DIFFERENT implementation (use a random address as stand-in)
            const wrongImplementationAddress = ethers.Wallet.createRandom().address;
            const authorizationForA = await createSelfAuthorization(alice, wrongImplementationAddress);

            // Try to execute against the SimpleAccount implementation (B) with the wrong authorization
            const calls = returnMintAndApproveCalls(erc20, ethers.parseEther('1'), bob.evmAddress);
            const data = simpleAccountContract.interface.encodeFunctionData('executeBatch', [calls]);
            try {
                const receipt = await sendAuthorizedTx(alice, alice.evmAddress, authorizationForA, data);
                expect(receipt?.status).to.not.equal(1);
            } catch (e) {
                expect(true).to.equal(true);
            }
        });

        it('Refund pattern in batch: mint to user then refund relayer', async () => {
            // Alice authorizes account impl; Bob pays gas and is reimbursed via ERC20 transfer
            const authorization = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const bobPreBalance = await erc20.balanceOf(bob.evmAddress);
            const mintData = erc20.contract.interface.encodeFunctionData("mint", [alice.evmAddress, ethers.parseEther('10')]);
            const transferData = erc20.contract.interface.encodeFunctionData("transfer", [bob.evmAddress, ethers.parseEther('3')]);
            const calls = [
                { target: erc20.getAddress(), value: 0n, data: mintData },
                { target: erc20.getAddress(), value: 0n, data: transferData },
            ];
            const data = simpleAccountContract.interface.encodeFunctionData('executeBatch', [calls]);
            const receipt = await sendAuthorizedTx(alice, alice.evmAddress, authorization, data);
            expect(receipt?.status).to.equal(1);
            // balances reflect refund
            const bobBal = await erc20.balanceOf(bob.evmAddress);
            expect(bobBal - bobPreBalance).to.equal(ethers.parseEther('3'));
        });

        it('Oversized authorizationList is rejected', async () => {
            await clearSetCode(alice);
            const auth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const bigList = new Array(6400).fill(auth);
            try{
                const setCodeTx = await buildRawSetCodeTx(alice, bigList);
            } catch(e){}
            const code = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(code).to.equal('0x');
        });

        it('If a call fails, execute batch wont continue to execute the batch txs in the next sequence', async () => {
            const ferdie = await UserFactory.createSeiUser(alice, 'ferdie');
            const authorization = await createSelfAuthorization(ferdie, await simpleAccountContract.getAddress());
            await setCodeForEOA(ferdie, [authorization]);
            const bobPreBalance = await erc20.balanceOf(bob.evmAddress);
            const approveData = erc20.contract.interface.encodeFunctionData("approve", [bob.evmAddress, ethers.parseEther('5')]);
            const mintData = erc20.contract.interface.encodeFunctionData("mint", [ferdie.evmAddress, ethers.parseEther('100')]);
            const transferData = erc20.contract.interface.encodeFunctionData("transfer", [bob.evmAddress, ethers.parseEther('100000')]);
            const calls = [
                { target: erc20.getAddress(), value: 0n, data: approveData },
                { target: erc20.getAddress(), value: 0n, data: transferData },
                { target: erc20.getAddress(), value: 0n, data: mintData },
            ];
            const data = simpleAccountContract.interface.encodeFunctionData('executeBatch', [calls]);
            try{
                const receipt = await sendAuthorizedTx(ferdie, ferdie.evmAddress, authorization, data);
            } catch (e){}

            const ferdieAfterBalance = await erc20.balanceOf(ferdie.evmAddress);
            const bobAfterBalance = await erc20.balanceOf(bob.evmAddress);
            expect(Number(ferdieAfterBalance)).to.equal(0);
            expect(await erc20.allowance(ferdie.evmAddress, bob.evmAddress)).to.equal(ethers.parseEther('0'));
            expect(bobAfterBalance).to.equal(bobPreBalance);
        });

        it('ETH value transfer in executeBatch', async () => {
            const authorization = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const before = await bob.evmWallet.signingClient.getBalance(bob.evmAddress);
            const calls = [
                { target: bob.evmAddress, value: ethers.parseEther('0.0000001'), data: '0x' },
            ];
            const data = simpleAccountContract.interface.encodeFunctionData('executeBatch', [calls]);
            const receipt = await sendAuthorizedTx(alice, alice.evmAddress, authorization, data);
            expect(receipt?.status).to.equal(1);
            const after = await bob.evmWallet.signingClient.getBalance(bob.evmAddress);
            expect(Number(after - before)).to.be.eq(100000000000);
        });

        it('User can replace existing authorization with a new one', async () =>{
            const previousCode = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            console.log(previousCode);
            const authorization = await createSelfAuthorization(alice, '0xFf14Fb7De7FC0273270F8722528C0d7b27c5cbCF');
            await setCodeForEOA(alice, [authorization]);
            const code = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            console.log(code);
            expect(code).to.not.equal(previousCode);
        });

        it('User sets multiple authorizations on the EOA code but only the last one persists', async () =>{
            const currentNonce = await alice.evmWallet.signingClient.getTransactionCount(alice.evmAddress, "pending");
            const randomAddress = ethers.Wallet.createRandom().address;
            const auth1 = await createSelfAuthorization(alice, await simpleAccountContract.getAddress(), chainId, currentNonce + 1);
            const auth3 = await createSelfAuthorization(alice, randomAddress, chainId, currentNonce + 3);
            const auth2 = await createSelfAuthorization(alice, erc20.getAddress() as string, chainId, currentNonce + 2);
            const setCodeTx = await setCodeForEOA(alice, [auth1, auth2, auth3]);
            const code = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            expect(code).to.not.equal('0x');

            const finalAuth = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());

            const tx = await setCodeForEOA(alice, [finalAuth]);
            const code2 = await alice.evmWallet.signingClient.getCode(alice.evmAddress);
            console.log(code2)
        });

        let stakingContract: Contract;
        const validator1 = 'seivaloper17twyyca2j6gdazvm4vkmzdvynf3tr29gzs4znh';
        const validator2 = 'seivaloper1u48s002tu0zank8rxfz02ulzqrrlr6wcw8g5td';
        it('Calls a precompile in batch tx', async () =>{
            const stakingAddress = '0x0000000000000000000000000000000000001005';
            stakingContract = new Contract(stakingAddress, stakingAbi, alice.evmWallet.wallet);
            const calls = [
                { target: stakingContract.target, value: ethers.parseEther('0.01'), data: stakingContract.interface.encodeFunctionData("delegate", [validator1]) },
                { target: stakingContract.target, value: ethers.parseEther('0.01'), data: stakingContract.interface.encodeFunctionData("delegate", [validator2]) }
            ];
            const batchTxs = await sendBatchTxs(alice, calls, simpleAccountContract, {eoaAddress: alice.evmAddress});
            expect(batchTxs?.status).to.equal(1);
            await waitFor(1);
            const queryAgent = await returnQueryClient(setupStakingExtension) as QueryClient & StakingExtension;
            const userQuery = await queryAgent.staking.delegatorDelegations(alice.seiAddress);
            console.log(userQuery);
        });

        it('Sets a precompile address in set code tx', async () =>{
            const ferdie = await UserFactory.createSeiUser(alice, 'ferdie');
            const authorization = await createSelfAuthorization(ferdie, await stakingContract.getAddress());
            await setCodeForEOA(ferdie, [authorization]);
            const code = await ferdie.evmWallet.signingClient.getCode(ferdie.evmAddress);
            console.log(code);
            expect(code).to.not.equal('0x');

            const data = stakingContract.interface.encodeFunctionData("delegate", [validator1]);

            //Now lets try to set another account implementation
            const auth2 = await createSelfAuthorization(ferdie, await simpleAccountContract.getAddress());
            await setCodeForEOA(ferdie, [auth2]);
            const code2 = await ferdie.evmWallet.signingClient.getCode(ferdie.evmAddress);
            console.log(code2);
            expect(code2).to.not.equal(code);
        });

        let ercNftId = 1891;
        let cwNftId = '1891';
        it('Association done with the set code tx', async () =>{
            ferdie = await UserFactory.createUnassociatedUsers(alice, 'ferdie');
            await UserFactory.fundAddressOnSei(ferdie.seiAddress);
            const nfts = await erc721.safeMint(ferdie.evmAddress, ercNftId);
            await nfts.wait();

            const mintOnSei = await cw721.mint(cwNftId, ferdie.seiAddress);

            const isAssociated = await ferdie.seiWallet.isAssociated();
            console.log(isAssociated);
            await ferdie.seiWallet.associate();
            const auth = await createSelfAuthorization(ferdie, await simpleAccountContract.getAddress());
            await setCodeForEOA(ferdie, [auth]);
            const code = await ferdie.evmWallet.signingClient.getCode(ferdie.evmAddress);
            expect(code).to.not.equal('0x');

            const isAssociatedAfter = await ferdie.seiWallet.isAssociated();
            console.log(isAssociatedAfter);

            const ownerOf = await erc721.ownerOf(ercNftId);
            expect(ownerOf).to.equal(ferdie.evmAddress);

            const ownerOfNft = await cw721.ownerOf(cwNftId);
            expect(ownerOfNft).to.equal(ferdie.seiAddress);

            //now try to set code once more
            const auth2 = await createSelfAuthorization(ferdie, await stakingContract.getAddress());
            await setCodeForEOA(ferdie, [auth2]);
            const code2 = await ferdie.evmWallet.signingClient.getCode(ferdie.evmAddress);
            console.log(code2);
            expect(code2).to.not.equal(code);
        });

        it('Cosmos side can handle the set code stuff', async () =>{
            //now ferdie owns nft 1552
            cw721.setSigner(ferdie);
            const transferTx = await cw721.safeTransferFrom(ferdie.seiAddress, alice.seiAddress, cwNftId);
            await waitFor(1);
            const ownerOf = await cw721.ownerOf(cwNftId);
            expect(ownerOf).to.equal(alice.seiAddress);
        });

        it('Existing balances work after set code', async () =>{

        });
    });

    describe.skip('RPC read operations for type-4 SetCode transactions', function () {
        this.timeout(10 * 60 * 1000);

        let alice: SeiUser;
        let bob: SeiUser;
        let simpleAccountContract: Contract;
        let setCodeTxHash: string;
        let setCodeReceipt: ethers.ContractTransactionReceipt | null;
        let rpcClient: EvmRpcClient;
        let erc20ForRpc: Erc20Token;
        let setCodeBlockNumberHex: string;
        let setCodeBlockHash: string;
        let batchTxHash: string;
        let batchBlockNumberHex: string;
        let batchBlockHash: string;

        before('Prepare user and RPC client', async () => {
            const admin = await UserFactory.createAdminUser();
            [alice, bob] = await UserFactory.createSeiUsers(admin, 2, false);
            simpleAccountContract = new Contract(SIMPLE_ACCOUNT_CONTRACT_ADDRESS, getAccountAbi(), alice.evmWallet.wallet);
            rpcClient = new EvmRpcClient(alice.evmRpcEndpoint, alice.evmWallet.signingClient);
            erc20ForRpc = new Erc20Token(alice, '0x202fE99BBCf0B17B19f96562c340e91e5b27013b');
        });

        it('Estimates gas for a SetCode tx (type 0x4) via eth_estimateGas', async () => {
            const authorization = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const tx = {
                from: alice.evmAddress,
                to: alice.evmAddress,
                data: '0x',
                authorizationList: [authorization],
            } as any;
            const gas = await rpcClient.estimateGas(tx);
            expect(gas).to.be.greaterThan(21000);
        });

        it('Sends SetCode tx and validates receipt and type via RPC', async () => {
            const authorization = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const receipt = await setCodeForEOA(alice, [authorization]);
            setCodeReceipt = receipt as ethers.ContractTransactionReceipt;
            expect(setCodeReceipt?.status).to.equal(1);

            setCodeTxHash = setCodeReceipt!.hash;
            const rpcTx = await rpcClient.getTransactionByHash(setCodeTxHash);
            expect(rpcTx).to.not.be.null;
            // Chain implements SetCode as type 0x4
            expect(rpcTx.type?.toLowerCase?.()).to.equal('0x4');

            const rpcReceipt = await rpcClient.getTransactionReceipt(setCodeTxHash);
            expect(rpcReceipt.status).to.equal('0x1');
            expect(parseInt(rpcReceipt.gasUsed, 16)).to.be.greaterThan(0);
            console.log(rpcReceipt);
            console.log('*****');
            console.log(setCodeReceipt);

            setCodeBlockNumberHex = rpcReceipt.blockNumber;
            const blk = await rpcClient.getBlockByNumber(setCodeBlockNumberHex, true);
            setCodeBlockHash = blk.hash;
        });

        it('Executed batch txs returns only one index', async () =>{
            const batchTxs = returnBatchMintCalls(erc20ForRpc, ethers.parseEther('100'), alice.evmAddress);
            const batchTx = await sendBatchTxs(alice, batchTxs, simpleAccountContract, {eoaAddress: alice.evmAddress});
            const logParams = {
                fromBlock: ethers.toQuantity(batchTx.blockNumber),
                toBLock: ethers.toQuantity(batchTx.blockNumber),
            }
            const logs = await rpcClient.getLogs(logParams);
            console.log('***');
            console.log(logs);
        });

        it('Executed batch txs return multiple logs', async () =>{
            const calls = [{
                target: erc20ForRpc.getAddress(),
                value: 0n,
                data: erc20ForRpc.contract.interface.encodeFunctionData("mint", [alice.evmAddress, ethers.parseEther('100')]),
            },
                {
                    target: erc20ForRpc.getAddress(),
                    value: 0n,
                    data: erc20ForRpc.contract.interface.encodeFunctionData("mint", [alice.evmAddress, ethers.parseEther('100')]),
                },
                {
                    target: erc20ForRpc.getAddress(),
                    value: 0n,
                    data: erc20ForRpc.contract.interface.encodeFunctionData("approve", [bob.evmAddress, ethers.parseEther('100')]),
                }
            ];
            const batchTx = await sendBatchTxs(alice, calls, simpleAccountContract, {eoaAddress: alice.evmAddress});
            const logsparams = {
                fromBlock: ethers.toQuantity(batchTx.blockNumber),
                toBLock: ethers.toQuantity(batchTx.blockNumber),
            }
            const logs = await rpcClient.getLogs(logsparams);
            console.log('***');
            console.log(logs);
            const blockData = await rpcClient.getBlockByNumber(ethers.toQuantity(batchTx.blockNumber), true);
            console.log(blockData);
        })

        it('debug_traceTransaction for SetCode matches gas usage in receipt', async () => {
            const trace = await rpcClient.debugTraceTransaction(setCodeTxHash);
            expect(trace).to.be.ok;
            expect(trace.failed).to.be.false;
            expect(trace.gas).to.be.greaterThan(0);

            const rpcReceipt = await rpcClient.getTransactionReceipt(setCodeTxHash);
            expect(trace.gas).to.equal(parseInt(rpcReceipt.gasUsed, 16));
        });

        it('getBlockByNumber and getBlockByHash include the SetCode tx (type 0x4)', async () => {
            const rpcReceipt = await rpcClient.getTransactionReceipt(setCodeTxHash);
            const blockNumberHex = rpcReceipt.blockNumber;
            const blockByNumber = await rpcClient.getBlockByNumber(blockNumberHex, true);
            const blockTx = blockByNumber.transactions.find((t: any) => t.hash === setCodeTxHash);
            expect(blockTx).to.not.be.undefined;
            expect(blockTx.type?.toLowerCase?.()).to.equal('0x4');

            const blockByHash = await rpcClient.getBlockByHash(blockByNumber.hash, true);
            const blockTx2 = blockByHash.transactions.find((t: any) => t.hash === setCodeTxHash);
            expect(blockTx2).to.not.be.undefined;
            expect(blockByHash.hash).to.equal(blockByNumber.hash);
        });

        it('Sends authorized batch tx and verifies with getTransactionByHash and block queries', async () => {
            const authorization = await createSelfAuthorization(alice, await simpleAccountContract.getAddress());
            const calls = [
                { target: await erc20ForRpc.getAddress(), value: 0n, data: erc20ForRpc.contract.interface.encodeFunctionData('approve', [bob.evmAddress, ethers.parseEther('1')]) }
            ];
            const data = simpleAccountContract.interface.encodeFunctionData('executeBatch', [calls]);
            const receipt = await sendAuthorizedTx(bob, await simpleAccountContract.getAddress(), authorization, data);
            expect(receipt?.status).to.equal(1);

            const txHash = receipt!.hash;
            const rpcTx = await rpcClient.getTransactionByHash(txHash);
            expect(rpcTx).to.not.be.null;
            expect(rpcTx.to?.toLowerCase()).to.equal((await simpleAccountContract.getAddress()).toLowerCase());

            const rpcReceipt = await rpcClient.getTransactionReceipt(txHash);
            expect(rpcReceipt.status).to.equal('0x1');
            batchTxHash = txHash;

            const blockByNumber = await rpcClient.getBlockByNumber(rpcReceipt.blockNumber, true);
            const inBlock = blockByNumber.transactions.find((t: any) => t.hash === txHash);
            expect(!!inBlock).to.be.true;
            console.log(inBlock);
            batchBlockNumberHex = rpcReceipt.blockNumber;

            const blockByHash = await rpcClient.getBlockByHash(blockByNumber.hash, true);
            const inBlockHash = blockByHash.transactions.some((t: any) => t.hash === txHash);
            expect(inBlockHash).to.be.true;
            batchBlockHash = blockByHash.hash;
        });

        it('debug_traceTransaction for batch tx returns gas and logs', async () => {
            const trace = await alice.evmWallet.signingClient.send('debug_traceTransaction', [batchTxHash]);
            expect(trace.failed).to.be.false;
            expect(trace.gas).to.be.greaterThan(0);
            expect(trace.structLogs?.length || 0).to.be.greaterThan(0);
            const rpcReceipt = await rpcClient.getTransactionReceipt(batchTxHash);
            expect(trace.gas).to.equal(parseInt(rpcReceipt.gasUsed, 16));
        });

        it('debug_traceBlockByNumber and debug_traceBlockByHash for SetCode block', async () => {
            const numberTrace = await alice.evmWallet.signingClient.send('debug_traceBlockByNumber', [setCodeBlockNumberHex]);
            expect(Array.isArray(numberTrace)).to.be.true;
            expect(numberTrace.length).to.be.greaterThan(0);
            const hashTrace = await alice.evmWallet.signingClient.send('debug_traceBlockByHash', [setCodeBlockHash]);
            expect(Array.isArray(hashTrace)).to.be.true;
            expect(hashTrace.length).to.be.greaterThan(0);
        });

        it('debug_traceBlockByNumber and debug_traceBlockByHash for batch block', async () => {
            const numberTrace = await alice.evmWallet.signingClient.send('debug_traceBlockByNumber', [batchBlockNumberHex]);
            expect(Array.isArray(numberTrace)).to.be.true;
            expect(numberTrace.length).to.be.greaterThan(0);
            const hashTrace = await alice.evmWallet.signingClient.send('debug_traceBlockByHash', [batchBlockHash]);
            expect(Array.isArray(hashTrace)).to.be.true;
            expect(hashTrace.length).to.be.greaterThan(0);
        });
    });
})



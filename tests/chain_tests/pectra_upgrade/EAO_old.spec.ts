import {ethers} from "ethers";
import {expect} from "chai";
import {SeiUser, UserFactory} from "../../../shared/User";
import {TokenDeployer} from "../../../shared/Deployer";
import {Erc20Token} from "../../../shared/Token";
import {EvmRpcClient} from "../../../shared/RpcClient";
import testConfig from "../../../config/testConfig.json";
import {waitFor} from "../../../shared/utils/helpers";
import {createAuthorization, executeBatchWithViem, sendType4Tx} from "./utils";
import heavyGasAbi from "../../../artifacts/contracts/GasBurner.sol/RealGasBurner.json";
import {RealGasBurner} from "../../../typechain-types";

const accountImplementationAddress = '0xa0F15a2f09F3BD4E289cd2DAa0CADA239b11b88C';
const simple7702Iface = new ethers.Interface([
    "function executeBatch(tuple(address target,uint256 value,bytes data)[] calls) external payable"
]);

describe('EAO / EIP-7702 - Transaction Type 4', function () {
    this.timeout(10 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let erc20: Erc20Token;
    let rpcClient: EvmRpcClient;
    let chainId: bigint;

    before('Initialize users, deploy ERC20, fund balances', async () => {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        [alice, bob] = await UserFactory.createSeiUsers(admin, 2, false);

        // const deployer = new TokenDeployer(admin);
        // erc20 = await deployer.deployErc20();
        erc20 = new Erc20Token(alice, '0x202fE99BBCf0B17B19f96562c340e91e5b27013b');
        rpcClient = new EvmRpcClient(testConfig.evmRpcEndpoint, admin.evmWallet.signingClient);

        // Fund Alice & Bob ERC20
        //await erc20.mint(alice.evmAddress, ethers.parseEther('1000').toString());
        //await waitFor(0.5);
        //await erc20.mint(bob.evmAddress, ethers.parseEther('1000').toString());
        //await waitFor(0.5);

        chainId = (await alice.evmWallet.signingClient.getNetwork()).chainId;
    });



    describe('Happy paths - type 4 transactions', function () {
        it.only('Batch: mint + approve via Simple7702Account (EIP-7702)', async () => {
            const mintAmount = ethers.parseEther('7');
            const approveAmount = ethers.parseEther('7');
            const preAlice = await erc20.balanceOf(alice.evmAddress);
            console.log('Pre-mint balance:', preAlice.toString());
            
            const mintData = erc20.contract.interface.encodeFunctionData('mint', [
                alice.evmAddress,
                mintAmount,
            ]);
            const approveData = erc20.contract.interface.encodeFunctionData('approve', [
                bob.evmAddress,
                approveAmount,
            ]);

            // Format calls according to EIP-7702 examples
            const calls = [
                {
                    target: await erc20.getAddress() as string,
                    value: 0n,
                    data: mintData,
                },
                {
                    target: await erc20.getAddress() as string,
                    value: 0n,
                    data: approveData,
                },
            ];

            console.log('Executing batch with EIP-7702 approach...');
            
            // Use the new EIP-7702 approach
            const batchHash = await executeBatchWithViem({
                fromUser: alice,
                contractAddress: accountImplementationAddress,
                calls,
            });

            console.log('Batch executed with hash:', batchHash);
            await waitFor(2);

            const postAlice = await erc20.balanceOf(alice.evmAddress);
            const allowance = await (erc20.contract as any).allowance(
                alice.evmAddress,
                bob.evmAddress,
            );

            console.log('Post-mint balance:', postAlice.toString());
            console.log('Allowance:', allowance.toString());

            expect(postAlice - preAlice).to.equal(mintAmount);
            expect(allowance).to.equal(approveAmount);
        });

        it('ERC20 transfer via type 4 with authorization succeeds and marks receipt.type = 4', async () => {
            const amount = ethers.parseEther('1');
            const preAlice = await erc20.balanceOf(alice.evmAddress);
            const preBob = await erc20.balanceOf(bob.evmAddress);

            // Create authorization for EOA to act as ERC20 contract
            const authNonce = await alice.evmWallet.wallet.getNonce('latest');
            const authorization = await createAuthorization({
                fromUser: alice,
                contractAddress: await erc20.getAddress() as string,
                nonce: authNonce,
                chainId
            });

            const data = erc20.contract.interface.encodeFunctionData(
                'transfer', [bob.evmAddress, amount]
            );
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const receipt = await sendType4Tx({
                fromUser: alice,
                to: await erc20.getAddress() as string,
                data,
                value: 0n,
                gasLimit: 120000n,
                maxFeePerGas: feeData.maxFeePerGas!,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: authNonce,
                chainId,
                authorizationList: [authorization]
            });
            console.log(receipt);

            expect(receipt).to.not.be.null;
            expect((receipt as any).status).to.equal(1);
            expect((receipt as any).type).to.equal(4);

            const postAlice = await erc20.balanceOf(alice.evmAddress);
            const postBob = await erc20.balanceOf(bob.evmAddress);
            expect(postAlice).to.equal(preAlice - amount);
            expect(postBob).to.equal(preBob + amount);
            console.log('Succeeded');

        });

        it('Approve via type 4, then transferFrom by spender succeeds', async () => {
            const amount = ethers.parseEther('2');
            const spender = bob; // Bob will spend Alice's tokens

            const preAlice = await erc20.balanceOf(alice.evmAddress);
            const preBob = await erc20.balanceOf(bob.evmAddress);

            // Alice authorizes to act as ERC20 and calls approve(spender, amount)
            const authNonce = await alice.evmWallet.wallet.getNonce('latest');
            const authorization = await createAuthorization({
                fromUser: alice,
                contractAddress: await erc20.getAddress() as string,
                nonce: authNonce,
                chainId
            });
            const approveData = erc20.contract.interface.encodeFunctionData(
                'approve', [spender.evmAddress, amount]
            );
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const approveReceipt = await sendType4Tx({
                fromUser: alice,
                to: await erc20.getAddress() as string,
                data: approveData,
                value: 0n,
                gasLimit: 100000n,
                maxFeePerGas: feeData.maxFeePerGas!,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: authNonce,
                chainId,
                authorizationList: [authorization]
            });
            expect(approveReceipt).to.not.be.null;
            expect((approveReceipt as any).status).to.equal(1);
            expect((approveReceipt as any).type).to.equal(4);

            // Bob executes transferFrom(alice -> bob, amount)
            const tf = await (erc20.contract.connect(bob.evmWallet.wallet) as any)
                .transferFrom(alice.evmAddress, bob.evmAddress, amount);
            const tfReceipt = await tf.wait();
            expect(tfReceipt?.status).to.equal(1);

            const postAlice = await erc20.balanceOf(alice.evmAddress);
            const postBob = await erc20.balanceOf(bob.evmAddress);
            expect(preAlice - postAlice).to.equal(amount);
            expect(postBob - preBob).to.equal(amount);
        });

        it('Sequential authorizations with incremented nonce both succeed', async () => {
            const sendOne = async (valueWei: bigint) => {
                const authNonce = await alice.evmWallet.wallet.getNonce('latest');
                const authorization = await createAuthorization({
                    fromUser: alice,
                    contractAddress: await erc20.getAddress() as string,
                    nonce: authNonce,
                    chainId
                });
                const feeData = await alice.evmWallet.signingClient.getFeeData();
                return sendType4Tx({
                    fromUser: alice,
                    to: bob.evmAddress,
                    data: '0x',
                    value: valueWei,
                    gasLimit: 21000n,
                    maxFeePerGas: feeData.maxFeePerGas!,
                    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                    nonce: authNonce,
                    chainId,
                    authorizationList: [authorization]
                });
            };

            const r1 = await sendOne(ethers.parseEther('0.0005'));
            expect(r1).to.not.be.null;
            expect((r1 as any).status).to.equal(1);
            expect((r1 as any).type).to.equal(4);

            const r2 = await sendOne(ethers.parseEther('0.0006'));
            expect(r2).to.not.be.null;
            expect((r2 as any).status).to.equal(1);
            expect((r2 as any).type).to.equal(4);
        });

        it('Heavy gas execution via type 4 succeeds', async () => {
            // Deploy GasBurner
            const factory = new ethers.ContractFactory(heavyGasAbi.abi, heavyGasAbi.bytecode, alice.evmWallet.wallet);
            const deployment = await factory.deploy();
            const gasBurner = await deployment.waitForDeployment() as unknown as RealGasBurner;

            const authNonce = await alice.evmWallet.wallet.getNonce('latest');
            const authorization = await createAuthorization({
                fromUser: alice,
                contractAddress: gasBurner.target as string,
                nonce: authNonce,
                chainId
            });

            const data = (gasBurner.interface as any).encodeFunctionData('burnGas', [1234]);
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const receipt = await sendType4Tx({
                fromUser: alice,
                to: gasBurner.target as string,
                data,
                value: 0n,
                gasLimit: 2_000_000n,
                maxFeePerGas: feeData.maxFeePerGas!,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: authNonce,
                chainId,
                authorizationList: [authorization]
            });
            expect(receipt).to.not.be.null;
            expect((receipt as any).status).to.equal(1);
            expect((receipt as any).type).to.equal(4);
        });
        it('Native ETH transfer via type 4 with authorization succeeds', async () => {
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const preAliceEth = await rpcClient.getBalance(alice.evmAddress);
            const preBobEth = await rpcClient.getBalance(bob.evmAddress);

            // For native transfer, we can authorize against a simple contract or use empty authorization
            const authNonce = await alice.evmWallet.wallet.getNonce('latest');
            const authorization = await createAuthorization({
                fromUser: alice,
                contractAddress: await erc20.getAddress() as string, // Use ERC20 as auth target
                nonce: authNonce,
                chainId
            });

            const receipt = await sendType4Tx({
                fromUser: alice,
                to: bob.evmAddress,
                data: '0x',
                value: ethers.parseEther('0.001'),
                gasLimit: 21000n,
                maxFeePerGas: feeData.maxFeePerGas!,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: authNonce,
                chainId,
                authorizationList: [authorization]
            });

            expect(receipt).to.not.be.null;
            expect((receipt as any).status).to.equal(1);
            expect((receipt as any).type).to.equal(4);

            const postAliceEth = await rpcClient.getBalance(alice.evmAddress);
            const postBobEth = await rpcClient.getBalance(bob.evmAddress);
            expect(postBobEth - preBobEth).to.equal(ethers.parseEther('0.001'));
            // Alice's ETH decreases by value + gas; check at least value portion moved
            expect(preAliceEth - postAliceEth).to.be.greaterThanOrEqual(ethers.parseEther('0.001'));
        });

        it('Type 4 transaction with custom fee parameters and authorization succeeds', async () => {
            const amount = ethers.parseEther('0.5');
            const data = erc20.contract.interface.encodeFunctionData(
                'transfer', [bob.evmAddress, amount]
            );
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const maxFeePerGas = ethers.parseUnits('9', 'gwei');
            const maxPriorityFeePerGas = ethers.parseUnits('2', 'gwei');

            // Create authorization for custom fee test
            const authorization = await createAuthorization({
                fromUser: alice,
                contractAddress: await erc20.getAddress() as string,
                nonce: nonce,
                chainId
            });

            const receipt = await sendType4Tx({
                fromUser: alice,
                to: await erc20.getAddress() as string,
                data,
                value: 0n,
                gasLimit: 100000n,
                maxFeePerGas,
                maxPriorityFeePerGas,
                nonce,
                chainId,
                authorizationList: [authorization]
            });

            expect(receipt).to.not.be.null;
            expect((receipt as any).status).to.equal(1);
            expect((receipt as any).type).to.equal(4);
        });
    });
});



import {SeiUser} from "../../modules/utils/User";
import {ERC20Token} from "../shared/Token";
import RPCClient from "../../tokens/utils/RPCClient";
import testConfig from "../testConfig.json";
import {returnExpect} from "../../modules/bank/utils";
import {ethers} from "ethers";
import ContractArtifacts from "../artifacts/contracts/TestERC20.sol/TestERC20.json";
import {createUsersFromMnemonic} from "../shared/EvmUtils";
import contractAddresses from "../contractAddresses.json";

describe('Evm Rpc Tests', function () {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let expect: Chai.ExpectStatic;
    let erc20: ERC20Token;
    let rpcClient: RPCClient;
    let ercPointerAddress: string;


    before('Initializes', async () => {
        admin = new SeiUser(testConfig.seiRpcEndpoint, testConfig.evmRpcEndpoint, testConfig.restEndpoint);
        await admin.initialize(testConfig.mnemonic, 'admin', false);
        expect = await returnExpect();
        users = await createUsersFromMnemonic();
        erc20 = new ERC20Token(admin, users, contractAddresses.erc20);
        await erc20.initialize();
        rpcClient = new RPCClient(admin.evmWallet.signingClient);
        ercPointerAddress = contractAddresses.cwPointerOnEvm;
    });

    it('should return the correct ERC20 balance using eth_call', async () => {
        const user = users[0];
        const balanceFromContract = await erc20.contract.balanceOf(user.evmAddress);

        const callData = erc20.contract.interface.encodeFunctionData('balanceOf', [user.evmAddress]);
        const callObject = {
            from: user.evmAddress,
            to: erc20.contractAddress,
            data: callData,
        };

        const response = await rpcClient.eth_call(callObject, 'latest');
        const decoded = erc20.contract.interface.decodeFunctionResult('balanceOf', response);
        const balanceFromCall = decoded[0];
        expect(balanceFromCall.toString()).to.be.eq(balanceFromContract.toString());
    });

    it('should not modify state when using eth_call', async () => {
        const user = users[0];
        const balanceBefore = await erc20.contract.balanceOf(user.evmAddress);

        const callData = erc20.contract.interface.encodeFunctionData('balanceOf', [user.evmAddress]);
        const callObject = {
            from: user.evmAddress,
            to: erc20.contractAddress,
            data: callData,
        };

        await rpcClient.eth_call(callObject, 'latest');

        const balanceAfter = await erc20.contract.balanceOf(user.evmAddress);
        expect(balanceAfter.toString()).to.be.eq(balanceBefore.toString());
    });

    it('should reject a call with invalid call data', async () => {
        const user = users[0];
        const invalidCallObject = {
            from: user.evmAddress,
            to: erc20.contractAddress,
            data: '0x1234',
        };
        try{
            const callObj = await rpcClient.eth_call(invalidCallObject, 'latest');
            throw new Error('Should have thrown');
        } catch(e: any){
            expect(e.info.error.code).to.be.eq(-32000);
            expect(e.info.error.message).to.be.eq('execution reverted');
        }
    });

    const tags = ['latest', 'finalized', 'earliest', 'safe'];
    for (const blockTag of tags){
        it(`Can read balances with tag ${blockTag}`, async () =>{
            const balanceBefore = await erc20.contract.balanceOf(admin.evmAddress);
            const callData = erc20.contract.interface.encodeFunctionData('balanceOf', [admin.evmAddress]);
            const callObject = {
                from: admin.evmAddress,
                to: erc20.contractAddress,
                data: callData,
            };

            await rpcClient.eth_call(callObject, 'latest');

            const balanceAfter = await erc20.contract.balanceOf(admin.evmAddress);
            expect(balanceAfter.toString()).to.be.eq(balanceBefore.toString());
        });
    }

    it('should simulate a state-changing transfer without modifying state', async () => {
        const sender = users[0];
        const receiver = users[1];

        const senderBalanceBefore = await erc20.contract.balanceOf(sender.evmAddress);
        const receiverBalanceBefore = await erc20.contract.balanceOf(receiver.evmAddress);

        const transferAmount = '1000';
        const callData = erc20.contract.interface.encodeFunctionData('transfer', [receiver.evmAddress, transferAmount]);
        const callObject = {
            from: sender.evmAddress,
            to: erc20.contractAddress,
            data: callData,
        };

        await rpcClient.eth_call(callObject, 'latest');

        const senderBalanceAfter = await erc20.contract.balanceOf(sender.evmAddress);
        const receiverBalanceAfter = await erc20.contract.balanceOf(receiver.evmAddress);
        expect(senderBalanceAfter.toString()).to.be.eq(senderBalanceBefore.toString());
        expect(receiverBalanceAfter.toString()).to.be.eq(receiverBalanceBefore.toString());
    });

    it('should revert when provided with an insufficient gas limit', async () => {
        const user = users[0];
        const callData = erc20.contract.interface.encodeFunctionData('balanceOf', [user.evmAddress]);
        const callObject = {
            from: user.evmAddress,
            to: erc20.contractAddress,
            data: callData,
            gas: '0x10',
        };
        try{
            const rpcResult = await rpcClient.eth_call(callObject, 'latest');
            throw new Error('Should have thrown');
        } catch(e: any){
            expect(e.info.error.code).to.be.eq(-32000);
            expect(e.info.error.message).to.contain('err: intrinsic gas too low');
        }
    });

    it('should ignore non-zero value in a view call', async () => {
        const user = users[0];
        const balanceBefore = await erc20.contract.balanceOf(user.evmAddress);
        const callData = erc20.contract.interface.encodeFunctionData('balanceOf', [user.evmAddress]);
        const callObject = {
            from: user.evmAddress,
            to: erc20.contractAddress,
            data: callData,
            value: '0x1',
        };
        try{
            const rpcResult = await rpcClient.eth_call(callObject, 'latest');
            throw new Error('Should have thrown');
        } catch(e: any){
            expect(e.info.error.code).to.be.eq(-32000);
            expect(e.info.error.message).to.be.eq('execution reverted');
        }
    });

    it('should return an error when calling a non-existent contract', async () => {
        const callData = erc20.contract.interface.encodeFunctionData('balanceOf', [users[0].evmAddress]);
        const callObject = {
            from: users[0].evmAddress,
            to: '0x0000000000000000000000000000000000000000',
            data: callData,
        };
        try{
            const rpcResult = await rpcClient.eth_call(callObject, 'latest');
            console.log(rpcResult);
        } catch(e: any){
            console.log(e);
        }
    });

    it('should revert when calling a non-existent function', async () => {
        const invalidCallData = '0xdeadbeef';
        const callObject = {
            from: users[0].evmAddress,
            to: erc20.contractAddress,
            data: invalidCallData,
        };
        try{
            const rpcResult = await rpcClient.eth_call(callObject, 'latest');
            throw new Error('Should have thrown');
        } catch(e: any){
            expect(e.info.error.code).to.be.eq(-32000);
            expect(e.info.error.message).to.be.eq('execution reverted');
        }
    });

    it('should return an error when using an invalid block tag', async () => {
        const callData = erc20.contract.interface.encodeFunctionData('balanceOf', [users[0].evmAddress]);
        const callObject = {
            from: users[0].evmAddress,
            to: erc20.contractAddress,
            data: callData,
        };
        try{
            const rpcResult = await rpcClient.eth_call(callObject, 'invalidBlockTag');
            throw new Error('Should have thrown');
        } catch(e: any){
            expect(e.info.error.code).to.be.eq(-32602);
            expect(e.info.error.message).to.be.eq('invalid argument 1: hex string without 0x prefix');
        }
    });

    it('should reject calls with extremely long or malformed input data', async () => {
        const longData = '0x' + 'ff'.repeat(1000);
        const callObject = {
            from: users[0].evmAddress,
            to: erc20.contractAddress,
            data: longData,
        };
        try{
            const rpcResult = await rpcClient.eth_call(callObject, 'latest');
            throw new Error('Should have thrown');
        } catch(e: any){
            expect(e.info.error.code).to.be.eq(-32000);
            expect(e.info.error.message).to.be.eq('execution reverted');
        }
    });

    it('Can call on pointers', async () =>{
        const pointerContract = new ethers.Contract(ercPointerAddress, ContractArtifacts.abi, admin.evmWallet.wallet);
        const balanceFromBefore = await pointerContract.balanceOf(admin.evmAddress);
        const callData = pointerContract.interface.encodeFunctionData('balanceOf', [admin.evmAddress]);
        const callObject = {
            from: admin.evmAddress,
            to: ercPointerAddress,
            data: callData,
        };
        const response = await rpcClient.eth_call(callObject, 'latest');
        const decoded = pointerContract.interface.decodeFunctionResult('balanceOf', response);
        const balanceFromCall = decoded[0];
        expect(balanceFromCall.toString()).to.be.eq(balanceFromBefore.toString());
    });
});

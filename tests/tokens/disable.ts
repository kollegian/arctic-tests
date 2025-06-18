import {UserFactory} from "../../shared/User";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import {ethers} from "ethers";
import {EvmRpcClient} from "../../shared/RpcClient";

describe('Tests', function () {
    this.timeout(3 * 60 * 1000);
    it('Existing pointers still work', async () => {
        const admin = await UserFactory.createAdminUser();
        const [alice, bob] = await UserFactory.createSeiUsers(admin, 2);
        const erc20 = new Erc20Token(admin, '0x09fc6710b17a8A3CEAF0F66E59f114B507f94a66');
        const cwPointer = new Cw20Token(admin, 'sei1feyva4paldahyg0lufydpnxeceah0he7tq00ct023jm50t4u66usvtqzh4');
        const rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
        const mintTx = await erc20.mint(alice.evmAddress, ethers.parseEther('100'));
        await mintTx.wait();

        const aliceBalance = await cwPointer.balanceOf(alice.seiAddress);
        console.log(aliceBalance);
        cwPointer.setSigner(alice);
        const transferTx = await cwPointer.transfer(bob.seiAddress, '100000');
        const bobBalance = await erc20.balanceOf(bob.evmAddress);
        console.log(bobBalance);
        const logs = {
            fromBlock: ethers.toQuantity(transferTx.height),
            toBlock: ethers.toQuantity(transferTx.height + 1),
            address: erc20.getAddress(),
        }
        const rpc = await rpcClient.sei_getLogs(logs);
        console.log(rpc);
        console.log('------')
        const ethLogs = await rpcClient.getLogs(logs);
        console.log(ethLogs);
    })
});

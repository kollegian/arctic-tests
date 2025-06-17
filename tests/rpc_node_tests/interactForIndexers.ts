import {ethers} from "ethers";
import erc20Abi from "../../artifacts/contracts/TestERC20.sol/TestERC20.json"
import {UserFactory} from "../../shared/User";
import * as testConfig from "../../config/testConfig.json";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import {AtomicTxSender} from "../../shared/TxBuilder";

const main = async () =>{
    const admin = await UserFactory.createAdminUser(testConfig);
    const contract = new Erc20Token(admin, '0x0e33ebFa08C48d916e8d3Fd802e7C556222F0A29');
    const users = await UserFactory.createSeiUsers(admin, 40, true);

    for (const user of users) {
        const encodedTx = contract.contract.interface.encodeFunctionData('mint', [user.evmAddress, ethers.parseEther('10')]);
        const signTx = await AtomicTxSender.signEvmTransaction(user, contract.getAddress(), encodedTx);
        await AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signTx, user);
    }
    const contrAddress = "sei195qcqm70gdqjwnjkkc54n3e0exz07axvwfn02fgme2n9rad83rrscajex3";
    const cw20 = new Cw20Token(admin, contrAddress);

    const balance = await cw20.balanceOf(users[0].seiAddress);
    console.log(balance);
    let latestResult;
    //Users sends from cw now
    for (const user of users) {
        cw20.setSigner(user);
        const result = await cw20.transfer(admin.seiAddress, '1000000000000');
        console.log(result);
        console.log('First tx sent');
        latestResult = result.height;
    }
    const seiBlock = await admin.evmWallet.signingClient.send('sei_getBlockByNumber', [ethers.toQuantity(latestResult), true]);
    console.log(seiBlock);

}

main().then(() => console.log('All sent'));

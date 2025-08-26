import {UserFactory} from "../../shared/User";
import erc20Abi from "../../artifacts/contracts/TestERC20.sol/TestERC20.json";
import {ethers} from "ethers";
import {UsersPool} from "./UsersPool";
import {waitFor} from "../../shared/utils/helpers";

const main = async () => {
    const admin = await UserFactory.createAdminUser();
    await UserFactory.fundAdminOnSei();
    console.log(admin.evmWallet.wallet.privateKey);
    const baseToken = new ethers.Contract('0x0453C2dcADeF880A4917528B1e0CD7fD35E5e27b', erc20Abi.abi, admin.evmWallet.wallet);
    const quoteToken = new ethers.Contract('0x4296Ef1959f8A2c1Df2F2FfE053351Cc3e66e487', erc20Abi.abi, admin.evmWallet.wallet);
    const vaultAddress = '0xBa48A5bb9712d070e74321bac4808984cC1b7419';
    const usersPool = new UsersPool();
    await usersPool.init(admin);
    const users = usersPool.all();
    let remaining = [...users];
    // const balance = await baseToken.balanceOf(users[0].evmAddress);
    // console.log(balance);
    while(remaining.length > 0) {
        const batch = remaining.splice(0, 40);
        const promises = batch.map(u => baseToken.connect(u.evmWallet.wallet).mint(u.evmAddress, ethers.parseEther('100')));
        await Promise.all(promises);
        await waitFor(1);
        console.log(`Minted to next batch (remaining: ${remaining.length})`);
        const promises2 = batch.map(u => quoteToken.connect(u.evmWallet.wallet).mint(u.evmAddress, ethers.parseEther('100')));
        await Promise.all(promises2);
        await waitFor(1);
        const promises3 = batch.map(u => baseToken.connect(u.evmWallet.wallet).approve(vaultAddress, ethers.MaxUint256));
        await Promise.all(promises3);
        await waitFor(1);
        console.log(`Approved to next batch (remaining: ${remaining.length})`);
        const promises4 = batch.map(u => quoteToken.connect(u.evmWallet.wallet).approve(vaultAddress, ethers.MaxUint256));
        await Promise.all(promises4);
        await waitFor(5);
    }
};

main();

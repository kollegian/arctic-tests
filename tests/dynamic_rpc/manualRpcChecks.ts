import {ethers} from "ethers";
import {SeiUser, UserFactory} from "../../shared/User";
import abi from '../../artifacts/contracts/storage.sol/StorageTest.json';


const main = async () =>{
    const rpc = 'https://evm-rpc-testnet.sei-apis.com';
    const admin = await UserFactory.createAdminUser();
    const provider = new ethers.JsonRpcProvider(rpc);
    console.log(admin.evmAddress);
    const blockNumber = await provider.getBlockNumber();

    const blockData = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), true]);
    const txs = blockData.transactions.map(tx => console.log(Number(tx.gasPrice)));


    const contract = new ethers.Contract('0x3330361030e8F2A18CC2dF1a8cCc33A354319B24', abi.abi, admin.evmWallet.wallet);
    const tx = await contract.setBalance(admin.evmAddress, ethers.parseEther('1'));
    const rcpt = await tx.wait();
    console.log(Number(rcpt.blockNumber));

    const encodedSlot = contract.interface.getAbiCoder().encode(  ["address","uint256"],
        [admin.evmAddress, 1]);
    console.log(encodedSlot);

    const slotKey = ethers.keccak256("0x00000000000000000000000044e3ca00494f9f44d92f3612b153419e87b02a390000000000000000000000000000000000000000000000000000000000000001");
    console.log(slotKey);
    // Contract address 0x3330361030e8F2A18CC2dF1a8cCc33A354319B24

}

main();

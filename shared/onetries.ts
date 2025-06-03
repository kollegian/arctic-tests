import {SeiUser, UserFactory} from './User';
import testConfig from '../config/testConfig.json'
import {ethers} from 'ethers';
import ERC20_ARTIFACT from '../artifacts/contracts/TestERC20.sol/TestERC20.json';
import * as TestConfig from "../config/testConfig.json";
import {TokenDeployer} from "./Deployer";
import {Erc20Token} from "./Token";
import { bech32 } from "bech32";

const main = async () => {
    const admin = await UserFactory.createAdminUser(testConfig);
    const contractAddress = '0x3894085ef7ff0f0aedf52e2a2704928d1ec074f1';

    const contract = new ethers.Contract(contractAddress, ERC20_ARTIFACT.abi, admin.evmWallet.wallet);
    const callData = contract.interface.encodeFunctionData('mint', [admin.evmAddress, ethers.parseEther('1')]);
    const callParams = [
        {
            from: admin.evmAddress,
            to: await contract.getAddress(),
            gasPrice: ethers.toQuantity(100000),
            value: '0x0',
            data: callData
        },
        'earliest',
        {
            tracer: 'callTracer'
        }
    ];
    const debugResult = await admin.evmWallet.signingClient.send('debug_traceCall', callParams);
    console.log(debugResult);
}

async function deployContractToMainnet() {
    const admin = await UserFactory.createAdminUser(TestConfig);
    console.log(admin.evmWallet.wallet.privateKey);
    console.log(admin.evmAddress);
    // const erc20 = new Erc20Token(admin, '0x711068BdAD9667100074693049d05c7D7cB02322');
    // const tx = await erc20.transfer('0x92D54824d32221FF3aC12B8cEA62D3de3ac332B9', ethers.parseEther('1'));
    // await tx.wait();
    const deployer = new TokenDeployer(admin);
    const ercToken = await deployer.deployErc20();
    // const tx = await erc20.mint(admin.evmAddress, ethers.parseEther('5').toString());
    // const receipt = await tx.wait();
    // console.log(receipt);
    // const balance = await erc20.balanceOf(admin.evmAddress);
    // console.log(balance);
    // const balanceAfter = await ercToken.balanceOf(admin.evmAddress);
    // console.log(balanceAfter);
}

async function convertAddress() {
    const provider = new ethers.JsonRpcProvider("https://evm-rpc.sei-apis.com");

// Define the ABI for the precompile contract
    const abi = [
        "function getEvmAddr(string seiAddress) view returns (address)"
    ];

// Create a contract instance
    const precompileAddress = "0x0000000000000000000000000000000000001004";
    const contract = new ethers.Contract(precompileAddress, abi, provider);

// Define your Sei address
    const seiAddress = "sei10zahefqt262mf7fx2jsf77h93zweldukcjf02l503u9j3plxyafq2d6tr9";

// Call the function to get the EVM address
    try {
        const evmAddress = await contract.getEvmAddr(seiAddress);
        console.log("Corresponding EVM Address:", evmAddress);
    } catch (error) {
        console.error("Error fetching EVM address:", error);
    }
}

export function seiToEvmAddress(seiAddress: string): string {
    // Decode Bech32 (HRP: 'sei') -> 5-bit data array
    const decoded = bech32.decode(seiAddress);
    const data = bech32.fromWords(decoded.words); // Convert 5-bit to 8-bit array

    if (data.length !== 20) {
        throw new Error("Expected 20-byte address payload");
    }

    // Convert to EVM address
    return ethers.getAddress("0x" + Buffer.from(data).toString("hex"));
}

deployContractToMainnet();

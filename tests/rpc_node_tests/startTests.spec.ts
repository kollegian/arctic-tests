import {SeiUser, UserFactory} from "../../shared/User";
import {EvmRpcClient} from "../../shared/RpcClient";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import {DebugContract} from "../../typechain-types";
import TestConfig from "../../config/testConfig.json";
import {TokenDeployer} from "../../shared/Deployer";
import fs from "fs";
import {waitFor} from "../../shared/utils/helpers";
import {ethers} from "ethers";

describe('Deploys the contracts and records addresses', function () {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let expect: Chai.ExpectStatic;
    let erc20: Erc20Token;
    let rpcClient: EvmRpcClient;
    let cwPointerAddress: string;
    let cwContractAddress: string;
    let ercPointerAddress: string;
    let pointerCw20: Cw20Token;
    let baseCw20: Cw20Token;
    let debugContract: DebugContract;

    before('Initializes', async () => {
        console.log('Deploying contracts and funding users for tests...');
        admin = await UserFactory.createAdminUser();
        //await UserFactory.fundAdminOnSei();
        users = await UserFactory.createSeiUsers(admin, 10, true);
        const deployer = new TokenDeployer(admin);
        console.log('Deploying to the chain now');
        erc20 = await deployer.deployErc20();
        console.log('Deployed to the chain');
        await erc20.mintToUsers(users);
        await waitFor(2);
        console.info('All users are funded for erc20');
        for (const user of users) {
            const balance = await erc20.contract.balanceOf(user.evmAddress);
            console.log(`User ${user.seiAddress} balance: ${balance}`);
        }
        cwPointerAddress = await erc20.deployPointer(TestConfig.evmRpcEndpoint);
        console.log(cwPointerAddress);
        const initialBalances = users.map(user =>{
            return {
                address: user.seiAddress,
                amount: '1000000000'
            }
        });
        baseCw20 = await deployer.deployCw20('wasm_store/cw20_base.wasm', {
            "name": 'myCwSolo',
            "symbol": 'mycwSolo',
            "decimals": 6,
            "initial_balances": initialBalances,
            "mint": {
                minter: admin.seiAddress,
            },
        }, 'myCwSolo');
        await baseCw20.deployPointer(TestConfig.evmRpcEndpoint);
        await waitFor(1);
        ercPointerAddress = await baseCw20.queryPointerAddress();
        pointerCw20 = new Cw20Token(admin, ercPointerAddress);
        await (await erc20.contract.mint(admin.evmAddress, ethers.parseEther('100000'))).wait();
        await baseCw20.mint(admin.seiAddress, '100000000000');
        debugContract = await deployer.deployDebugContract();
    });

    it('Writes contract addresses to a file', async () => {
       const contractInfo = {
           erc20: erc20.getAddress(),
           cw20: baseCw20.getAddress(),
           ercPointerOnCosmos: 'cwPointerAddress',
           cwPointerOnEvm: ercPointerAddress,
           debugAddress: await debugContract.getAddress()
       };
       fs.writeFileSync('./tests/rpc_node_tests/contractAddresses.json', JSON.stringify(contractInfo));
    });

    it('Writes user mnemonics to a file', async () => {
        const mnemonics = users.map(user => user.seiWallet.wallet.mnemonic);
        fs.writeFileSync('mnemonics.json', JSON.stringify(mnemonics));
    });
})

import {SeiUser, UserFactory} from "../../shared/User";
import {TokenDeployer} from "../../shared/Deployer";
import fs from "fs";
import {waitFor} from "../../shared/utils/helpers";

describe('Deploy contracts and fund users here', function(){
    this.timeout(2 * 60 * 1000);
    let admin: SeiUser;
    let users: SeiUser[];
    before('Clears the mnemonic file', () =>{
        fs.writeFileSync('./config/mnemonics.json', '[]');
        fs.writeFileSync('./tests/tokens/contractAddresses.json', '{}');
    }) ;

    it('Deploy contracts and fund users', async () => {
        admin = await UserFactory.createAdminUser();
        console.log('Admin created');
        // await UserFactory.fundAdminOnSei();
        users = await UserFactory.createSeiUsers(admin, 10, true);
        console.log('Users created');
        const deployer = new TokenDeployer(admin);
        const initialBalances = users.map(user => ({address: user.seiAddress, amount: '100000000'}));
        const cw20 = await deployer.deployCw20('wasm_store/cw20_base_1.wasm', {
            "name": 'myCwSolo',
            "symbol": 'mycwSolo',
            "decimals": 6,
            "initial_balances": initialBalances,
            "mint": {
                minter: admin.seiAddress,
            },
        }, 'myCwSolo');
        const cw20MultiMintTx = await cw20.mintMultiple(users.map(user => user.seiAddress), users.map(user => '100000000'));
        const cw721 = await deployer.deployCw721('wasm_store/cw2981_royalties.wasm', {
            name: 'cw721',
            symbol: 'mycw',
            minter: admin.seiAddress,
        }, 'mycw');
        const nftIds = users.map((_, i) => i.toString());
        const tx = await cw721.mintMultiple(nftIds, users.map(user => user.seiAddress));

        const erc20 = await deployer.deployErc20();
        await erc20.mintToUsers(users);
        console.log('Erc20 minted');
        await waitFor(2);
        const erc721 = await deployer.deployErc721("TestNFT", "TNFT", "https://example.com/");
        users.forEach(async (user, index) => {
            const nftId = index.toString();
            await erc721.safeMint(user.evmAddress, nftId);
        })
        console.log('All contracts are deployed and users funded.');
        fs.writeFileSync('./tests/tokens/contractAddresses.json', JSON.stringify({
            cw20Address: cw20.getAddress(),
            cw721Address: cw721.getAddress(),
            erc20Address: erc20.getAddress(),
            erc721Address: erc721.getAddress(),
            cw20MultiMintTx: cw20MultiMintTx.height,
            cw721MultiMintTx: tx.height,
        }, null, 2));
    });
})

// Flow => Users are funded. How many users?
// User should be controllable.
//Deploy token easily
// Call methods easily
// Have utilities available


import {SeiUser, UserFactory} from "../../shared/User";
import * as TestConfig from "../../config/testConfig.json";
import {Erc721Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import {expect} from 'chai';
import {TestNFT} from "../../typechain-types";
import {waitFor} from "../../utils/helpers";

describe('Token721 Tests', function () {
    this.timeout(10 * 60 * 1000);
    let admin: SeiUser;
    let users: SeiUser[];
    let erc721: Erc721Token;
    let erc721Contract: TestNFT;

    before('Admin deploys token721', async () => {
        admin = await UserFactory.createAdminUser(TestConfig);
        await UserFactory.fundAdminOnSei();
        users = await UserFactory.createSeiUsers(admin, 4, true);
        const deployer = new TokenDeployer(admin);
        await deployer.deployErc20();
        //If already deployed use
        // erc721 = new Erc721Token(admin, '0x711068BdAD9667100074693049d05c7D7cB02322');
        // erc721Contract = erc721.getContract();
    });

    it('Can query token name', async () => {
        console.log(await erc721.name());
        expect(await erc721.name()).to.be.eq('MyToken');
    });

    it('Admin mints a new token', async () => {
        const nextId = await erc721.returnNextId();
        const tx = await erc721.safeMint(admin.evmAddress, nextId);
        const receipt = await tx.wait();
        const ownership = await erc721.ownerOf(nextId);
        expect(ownership).to.be.eq(admin.evmAddress);
    });

    it('Admin transfers nft ownership to Bob', async () => {
        const latestMinted = await erc721.returnNextId();
        const tx = await erc721.safeTransferFrom(admin.evmAddress, users[1].evmAddress, Number(latestMinted) - 1);
        const receipt = await tx.wait();
        const ownership = await erc721.ownerOf(Number(latestMinted) - 1);
        expect(ownership).to.be.eq(users[1].evmAddress);
    });

    it('Admin cant transfer a token that doesnt exist', async () => {
        const toBeMinted = await erc721.returnNextId();
        await (expect(erc721
            .safeTransferFrom(admin.evmAddress, users[1].evmAddress, Number(toBeMinted) - 1))).to.be.reverted;
    });

    it('Alice can mint token', async () => {
        const nftId = await erc721.returnNextId();
        const tx = await erc721.contract.connect(users[1].evmWallet.wallet).safeMint(users[1].evmAddress, nftId);
        const receipt = await tx.wait();
        const ownership = await erc721.ownerOf(nftId);
        console.log(receipt);
        expect(ownership).to.be.eq(users[1].evmAddress);
    });

    let userBalances = [];
    it('All users can mint tokens', async () => {
        const contract = erc721.getContract();
        let nftId = Number(await erc721.returnNextId());
        console.log(nftId);
        const batch = [...users];
        while (batch.length > 0) {
            const promises = [];
            for (const user of batch.splice(0, 100)) {
                console.log(user.evmAddress);
                userBalances.push({[user.evmAddress]: nftId});
                promises.push(contract.connect(user.evmWallet.wallet).safeMint(user.evmAddress, nftId++, {gasLimit: 2000000}));
                console.log(nftId);
            }
            const txs = await Promise.all(promises);
            const receipts = await Promise.all(txs.map(tx => tx.wait()));
            await waitFor(0.2);
            console.log(receipts);
        }
        await waitFor(2);
        const randomIndex = Math.floor(Math.random() * userBalances.length);
        console.log(userBalances);
        const expectedAddress = Object.keys(userBalances[randomIndex])[0];
        const expectedId = userBalances[randomIndex][expectedAddress];
        console.log(expectedAddress, expectedId);
        const nftInfo = await erc721.ownerOf(expectedId);
        expect(nftInfo).to.be.eq(expectedAddress);
    });

    it('Nft transfers ownership checks', async () => {
        const randomIndex = Math.floor(Math.random() * userBalances.length);
        const expectedAddress = Object.keys(userBalances[randomIndex])[0];
        const expectedId = userBalances[randomIndex][expectedAddress];
    })

    it('Multiple transfers in a block works', async () => {

    });

    it('Multiple transfers in a block with cosmos txs', async ()=>{

    });

    it('One failing tx on nft transfer on a block', async ()=>{

    });

    it('')

})

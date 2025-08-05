import {SeiUser, UserFactory} from "../../shared/User";
import {Cw1155Token, Cw20Token, Cw721Token, Erc20Token, Erc721Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import {ethers} from "ethers";
import soloAbi from "./abis/solo_abi.json"
import {expect} from "chai";
import * as util from "node:util";
import {exec as execCallback} from "node:child_process";
import {execCommandAndReturnJson, getSoloAllPayload, getSoloPayload} from "../../shared/utils/cliUtils";
import {hex2uint8, waitFor} from "../../shared/utils/helpers";
const exec = util.promisify(execCallback);

describe('Solo precompile tests', function () {
    this.timeout(5 * 60 * 1000);
    let admin: SeiUser, alice: SeiUser, bob: SeiUser;
    let cw20: Cw20Token;
    let erc20: Erc20Token;
    let erc721: Erc721Token;
    let cw721: Cw721Token;
    let cw1155: Cw1155Token;
    let erc20Pointer: Cw20Token;
    let erc721Pointer: Cw721Token;
    let soloContract: ethers.Contract;
    let ferdie: SeiUser;
    let deployer: TokenDeployer;

    before('Deploys all contracts', async () => {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        alice = await UserFactory.createSeiUser(admin, 'alice');
        bob = await UserFactory.createSeiUser(admin, 'bob');
        ferdie = await UserFactory.createUnassociatedUsers(admin, 'ferdie');

        deployer = new TokenDeployer(admin);
        cw20 = await deployer.deployCw20('./wasm_store/cw20_base.wasm', {
            name: "Test",
            symbol: "TEST",
            decimals: 6,
            mint: {
                minter: admin.seiAddress,
            },
            initial_balances: [
                {address: admin.seiAddress, amount: "10000000"},
                {address: bob.seiAddress, amount: "30000000"}]
        }, 'MYTest');
        erc20 = await deployer.deployErc20();
        erc721 = await deployer.deployErc721('ERC721', 'ERC721', 'https://example.com/');
        cw721 = await deployer.deployCw721('./wasm_store/cw2981_royalties.wasm', {
            name: "Test",
            symbol: "TEST",
            minter: admin.seiAddress,
        }, 'MyTest');
        cw1155 = await deployer.deployCw1155('./wasm_store/cw1155_base.wasm', {
            name: "Test",
            symbol: "TEST",
            minter: admin.seiAddress,
        }, 'MyTest');
        soloContract = new ethers.Contract('0x000000000000000000000000000000000000100C', soloAbi, admin.evmWallet.wallet);
    });

    it.only('Given that a user has cw20 tokens, they can transfer all with solo to an evm address before pointers', async () => {
        const userBalance = await cw20.balanceOf(admin.seiAddress);
        console.log(userBalance);
        /*const pointer = await cw20.deployPointer(admin.evmRpcEndpoint);
        await waitFor(1);*/
        const payload = await getSoloPayload('admin', alice.evmAddress, 'CW20', cw20.getAddress());
        const payloadArry = hex2uint8(payload);
        const tx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await tx.wait();
        const afterBalance = await cw20.balanceOf(admin.seiAddress);
        expect(Number(afterBalance)).to.equal(0);
        const aliceBalance = await cw20.balanceOf(alice.seiAddress);
        expect(aliceBalance).to.equal(userBalance);
    });

    it('Allowances dont carry over', async () => {
        cw20.setSigner(bob);
        await cw20.approve(admin.seiAddress, '10000000');
        const allowance = await cw20.allowance(bob.seiAddress, admin.seiAddress);
        console.log(allowance);

        const payload = await getSoloPayload('bob', alice.evmAddress, 'CW20', cw20.getAddress());
        const payloadArry = hex2uint8(payload);
        const tx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await tx.wait();
        const afterBalance = await cw20.balanceOf(alice.seiAddress);
        expect(Number(afterBalance)).to.equal(40000000);
        const aliceBalance = await cw20.balanceOf(bob.seiAddress);
        expect(Number(aliceBalance)).to.equal(0);
    });

    it('Can be sent to multiple addresses from same user', async () => {
        // alice has 40000000
        const payload = await getSoloPayload('alice', bob.evmAddress, 'CW20', cw20.getAddress());
        const payloadArry = hex2uint8(payload);
        const tx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await tx.wait();
        const afterBalance = await cw20.balanceOf(alice.seiAddress);
        expect(Number(afterBalance)).to.equal(0);
        const aliceBalance = await cw20.balanceOf(bob.seiAddress);
        expect(Number(aliceBalance)).to.equal(40000000);
    })

    it('After deploying pointers users will be able to claim again for cw20', async () => {
        const preBalance = await cw20.balanceOf(admin.seiAddress);
        expect(Number(preBalance)).to.equal(0);
        cw20.setSigner(admin);
        const mintTx = await cw20.mint(admin.seiAddress, '10000000');
        const afterMintBalance = await cw20.balanceOf(admin.seiAddress);
        expect(afterMintBalance).to.be.eq('10000000');
        const pointer = await cw20.deployPointer(admin.evmRpcEndpoint);
        await waitFor(1);
        const pointerContr = new Erc20Token(admin, await cw20.queryPointerAddress());
        const aliceBalance = await pointerContr.balanceOf(alice.evmAddress);
        expect(Number(aliceBalance)).to.equal(0);

        const payload = await getSoloPayload('admin', alice.evmAddress, 'CW20', cw20.getAddress());
        const payloadArry = hex2uint8(payload);
        const tx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await tx.wait();
        const afterBalance = await cw20.balanceOf(admin.seiAddress);
        const aliceAfterBalance = await pointerContr.balanceOf(alice.evmAddress);
        expect(Number(afterBalance)).to.equal(0);
        expect(Number(aliceAfterBalance)).to.equal(10000000);
    });

    it('Given that a user has cw721 token, they can transfer all with solo to an evm address', async () => {
        const nftId = '1';
        const tx = await cw721.mintTx(nftId, admin.seiAddress);
        const owner = await cw721.ownerOf(nftId);
        expect(owner).to.equal(admin.seiAddress);
        const payload = await getSoloPayload('admin', alice.evmAddress, 'CW721', cw721.getAddress());
        const payloadArry = hex2uint8(payload);
        const claimTx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await claimTx.wait();
        const ownerAfter = await cw721.ownerOf(nftId);
        expect(ownerAfter).to.equal(alice.seiAddress);
    });

    it('Transfers royalty information as well', async () => {
        const tokenInfo = await cw721.queryRoyaltyInfo('1', '10000000');
        expect(tokenInfo.address).to.equal(admin.seiAddress);
        expect(tokenInfo.royalty_amount).to.equal('1000000');
    });

    it('Given that a user has multiple nft minted from same contract, claim specific moves all tokens', async () => {
        await cw721.mintTx('2', bob.seiAddress);
        await cw721.mintTx('3', bob.seiAddress);
        await cw721.mintTx('4', bob.seiAddress);
        await cw721.mintTx('5', bob.seiAddress);
        cw721.setSigner(bob);
        const allowanceTx = await cw721.approve(admin.seiAddress, '3');
        const payload = await getSoloPayload('bob', alice.evmAddress, 'CW721', cw721.getAddress());
        const payloadArry = hex2uint8(payload);
        const claimTx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await claimTx.wait();
        const ownerAfter = await cw721.ownerOf('2');
        expect(ownerAfter).to.equal(alice.seiAddress);
        const ownerAfter2 = await cw721.ownerOf('3');
        expect(ownerAfter2).to.equal(alice.seiAddress);
        const ownerAfter3 = await cw721.ownerOf('4');
        expect(ownerAfter3).to.equal(alice.seiAddress);
    });

    it('Given that a user has allowance set, transferring dont affect anything', async () => {
        const allowance = await cw721.queryApprovals(3);
        console.log(allowance);
    });

    it.skip('Users can use solo to transfer from erc pointer contracts', async () => {
        const pointerAddr = await erc20.deployPointer(admin.evmRpcEndpoint);
        const pointerCw20 = new Cw20Token(admin, pointerAddr);
        const aliceTx = await erc20.contract.setBalance(alice.evmAddress, ethers.parseEther('10').toString());
        await aliceTx.wait();
        console.log('Balance set');
        const pointerBalance = await pointerCw20.balanceOf(alice.seiAddress);
        expect(pointerBalance).to.equal(ethers.parseEther('10'));
        console.log('Balance checked');
        const payload = await getSoloPayload('alice', admin.evmAddress, 'ERC20', pointerAddr);
        const payloadArry = hex2uint8(payload);
        const claimTx = await soloContract.connect(admin.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await claimTx.wait();
        console.log('Tx sent');
        const pointerBalanceAfter = await pointerCw20.balanceOf(alice.seiAddress);
        expect(pointerBalanceAfter).to.equal(ethers.parseEther('10'));
    });

    it.skip('Given that a user has a bunch of cw1155 tokens, they can transfer all with solo to an evm address', async () => {
        const amount = 100;
        const tokenUri = 'uri1';

        await cw1155.mint({
            recipient: alice.seiAddress,
            tokenId: '1',
            amount: amount,
            tokenUri: tokenUri,
        });

        const balance = await cw1155.balanceOf(alice.seiAddress, '1');
        console.log(balance);
        const payload = await getSoloPayload('alice', admin.evmAddress, 'CW1155', cw1155.getAddress());
        const payloadArry = hex2uint8(payload);
        const claimTx = await soloContract.connect(admin.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await claimTx.wait();
        console.log('Sent');
        const balanceAfter = await cw1155.balanceOf(alice.seiAddress, '1');
        expect(balanceAfter).to.equal(0);
        const balanceRecvrAfter = await cw1155.balanceOf(admin.seiAddress, '1');
        expect(balanceRecvrAfter).to.equal(amount);
    });

    it.only('Works with usei balance', async () => {
        const newUser = await UserFactory.createUnassociatedUsers(admin, 'eva', true);
        await UserFactory.fundAddressOnSei(newUser.seiAddress, 'usei', '1000000');
        await newUser.seiWallet.associate();
        console.log(await newUser.seiWallet.queryBalance());

        const payload = await getSoloAllPayload('eva', admin.evmAddress);
        const payloadArr = hex2uint8(payload);
        const alicePreBalance = await alice.evmWallet.queryBalance();
        console.log(alicePreBalance);
        try {
            const claimTx = await soloContract.connect(alice.evmWallet.wallet).claim(payloadArr, {gasLimit: 1000000});
            await claimTx.wait();
        } catch (e) {
            console.log(e.message);
        }
        const balance = await newUser.seiWallet.queryBalance();
        console.log(balance);
        const alicePostBalance = await alice.evmWallet.queryBalance();
        console.log(alicePostBalance);
    });

    it('Vested balances works with usei', async () => {
        const newUser = await UserFactory.createUnassociatedUsers(admin, 'dave');
        const currentTime = Math.floor(Date.now() / 1000);
        const endTime = currentTime + 600;
        const res = await execCommandAndReturnJson(`seid tx vesting create-vesting-account ${newUser.seiAddress} 1000000usei ${endTime} --from admin --fees 24200usei -y`);
        await UserFactory.fundAddressOnSei(newUser.seiAddress, 'usei', '1000000');
        await newUser.seiWallet.associate();
        //now user has 2 sei 1 vested and locked
        const balance = await newUser.seiWallet.queryBalance();
        console.log(balance);
        const adminBalance = await admin.seiWallet.queryBalance();
        console.log(adminBalance);
        const payload = await getSoloAllPayload('dave', admin.evmAddress);
        const payloadArr = hex2uint8(payload);
        try {
            const claimTx = await soloContract.connect(admin.evmWallet.wallet).claim(payloadArr, {gasLimit: 1000000});
            await claimTx.wait();
        } catch (e) {

        }
        const recvrBalance = await admin.seiWallet.queryBalance();
        console.log(recvrBalance);
        const balance2 = await newUser.seiWallet.queryBalance();
        console.log(balance2);
    });

    let denomName: string;
    it.only('Given that a user has tokenfactory denoms they should be able to be claimed', async () => {
        const tokenFactoryDenom = await execCommandAndReturnJson(`seid tx tokenfactory create-denom mydenom --from alice --fees 24200usei -y`);
        denomName = `factory/${alice.seiAddress}/mydenom`;
        console.log(tokenFactoryDenom);
        await waitFor(0.5);
        const out = await execCommandAndReturnJson(`seid tx tokenfactory mint 10000000${denomName} --from alice --fees 24200usei -y`);
        console.log(out);
        await waitFor(0.5);
        const tokenBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom ${denomName} --output json`);
        console.log(tokenBalance);

        const payload = await getSoloAllPayload('alice', admin.evmAddress);
        const payloadArr = hex2uint8(payload);
        try {
            const claimTx = await soloContract.connect(admin.evmWallet.wallet).claim(payloadArr, {gasLimit: 1000000});
            await claimTx.wait();
        } catch (e) {
        }
        const recvrBalance = await execCommandAndReturnJson(`seid q bank balances ${admin.seiAddress} --denom ${denomName} --output json`);
        console.log(recvrBalance);
        const senderBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom ${denomName} --output json`);
        console.log(senderBalance);
    });


    it('Given that a user has tokenfactory, cw20 and cw721 balances, it should work', async () => {
        const aliceUseiBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom usei --output json`);
        console.log(aliceUseiBalance);
        await UserFactory.fundAddressOnSei(alice.seiAddress, 'usei', '1000000');
        await execCommandAndReturnJson(`seid tx tokenfactory mint 10000000${denomName} --from alice --fees 24200usei -y`);
        const alicePreSeiBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom usei --output json`);
        const alicePreTokenBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom ${denomName} --output json`);
        cw20.setSigner(admin);
        await cw20.mint(alice.seiAddress, '10000000');
        await cw721.mintTx('100', alice.seiAddress);
        await cw721.mintTx('200', alice.seiAddress);
        const alicePreBalanceCw20 = await cw20.balanceOf(alice.seiAddress);
        console.log(alicePreBalanceCw20);
        console.log(alicePreSeiBalance);
        console.log(alicePreTokenBalance);
        console.log('Bobs pre balances');
        console.log(await execCommandAndReturnJson(`seid q bank balances ${bob.seiAddress} --denom usei --output json`));
        console.log(await execCommandAndReturnJson(`seid q bank balances ${bob.seiAddress} --denom ${denomName} --output json`));
        console.log(await cw20.balanceOf(bob.seiAddress));
        console.log(await cw721.ownerOf('100'));

        const payload = await getSoloAllPayload('alice', bob.evmAddress);
        const payloadArr = hex2uint8(payload);
        try {
            const claimTx = await soloContract.connect(bob.evmWallet.wallet).claim(payloadArr, {gasLimit: 1000000});
            await claimTx.wait();
        } catch (e) {
            console.log(e);
        }
        const recvrBalance = await execCommandAndReturnJson(`seid q bank balances ${bob.seiAddress} --denom ${denomName} --output json`);
        console.log(recvrBalance);
        const bobAfterBalanceSei = await execCommandAndReturnJson(`seid q bank balances ${bob.seiAddress} --denom usei --output json`);
        console.log(bobAfterBalanceSei);
        const bobAfterCw20Balance = await cw20.balanceOf(bob.seiAddress);
        console.log(bobAfterCw20Balance);
        const nftOwnership = await cw721.ownerOf('100');
        console.log(nftOwnership);
        const nftOwnership2 = await cw721.ownerOf('200');
        console.log(nftOwnership2);
        console.log(await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom ${denomName} --output json`));
    });

    it('Given that a user has multiple cw20 balances', async () => {
        const aliceBalance = await cw20.balanceOf(alice.seiAddress);
        console.log(aliceBalance);

        const newCw20 = await deployer.deployCw20('./precompiles_test/store/cw20_base.wasm', {
            name: "TestTwo",
            symbol: "TESTTWO",
            decimals: 6,
            mint: {
                minter: admin.seiAddress,
            },
            initial_balances: [
                {address: admin.seiAddress, amount: "10000000"},
                {address: alice.seiAddress, amount: "30000000"}]
        }, 'MYTestTWO');

        console.log(await newCw20.balanceOf(alice.seiAddress));
        console.log(await cw20.balanceOf(bob.seiAddress));
        console.log('After balances');
        const {stdout} = await exec(`seid tx evm print-claim-specific ${bob.evmAddress} CW20 ${cw20.getAddress()} CW20 ${newCw20.getAddress()} --from alice --fees 24200usei -y`);
        const payloadArr = hex2uint8(stdout);
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        const bobBalance = await cw20.balanceOf(bob.seiAddress);
        console.log(bobBalance);
        const bobBalance2 = await newCw20.balanceOf(bob.seiAddress);
        console.log(bobBalance2);
        const aliceAfterBalance = await cw20.balanceOf(alice.seiAddress);
        console.log(aliceAfterBalance);
        const aliceAfterBalance2 = await newCw20.balanceOf(alice.seiAddress);
        console.log(aliceAfterBalance2);

    });

    it('Given that a user has multiple cw721 balances', async () => {
        await cw721.mintTx('111', alice.seiAddress);
        const newCw721 = await deployer.deployCw721('./precompiles_test/store/cw2981_royalties.wasm', {
            name: "Test",
            symbol: "TEST",
            minter: admin.seiAddress,
        }, 'MyTest');
        await newCw721.mintTx('111', alice.seiAddress);
        const {stdout} = await exec(`seid tx evm print-claim-specific ${bob.evmAddress} CW721 ${cw721.getAddress()} CW721 ${newCw721.getAddress()} --from alice --fees 24200usei -y`);
        const payloadArr = hex2uint8(stdout);
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        console.log(bob.seiAddress);
        const bobBalance = await cw721.ownerOf('111');
        console.log(bobBalance);
        const bobBalance2 = await newCw721.ownerOf('111');
        console.log(bobBalance2);
    });

    it('Given that a user has cw20 and cw721 balance', async () =>{
        const aliceBalance = await cw20.mint(alice.seiAddress, '10000000');
        const aliceBalance2 = await cw721.mintTx('222', alice.seiAddress);
        console.log(aliceBalance);
        console.log(aliceBalance2);
        console.log('Bob cw20 balance before', await cw20.balanceOf(bob.seiAddress));
        const {stdout} = await exec(`seid tx evm print-claim-specific ${bob.evmAddress} CW20 ${cw20.getAddress()} CW721 ${cw721.getAddress()} --from alice --fees 24200usei -y`);
        const payloadArr = hex2uint8(stdout);
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        console.log(bob.seiAddress);
        const bobBalance = await cw20.balanceOf(bob.seiAddress);
        console.log(bobBalance);
        console.log(await cw721.ownerOf('222'));
        console.log(await cw20.balanceOf(alice.seiAddress));
    });

    it('Given that a user has 0 balance on cw20 but valid balance on cw721', async () =>{
        const aliceBalance = await cw721.mintTx('333', alice.seiAddress);
        const {stdout} = await exec(`seid tx evm print-claim-specific ${bob.evmAddress} CW20 ${cw20.getAddress()} CW721 ${cw721.getAddress()} --from alice --fees 24200usei -y`);
        console.log('Bob pre balance is ', await cw20.balanceOf(bob.seiAddress));
        const payloadArr = hex2uint8(stdout);
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        console.log(bob.seiAddress);
        const bobBalance = await cw20.balanceOf(bob.seiAddress);
        console.log(bobBalance);
        console.log(await cw721.ownerOf('333'));
    });

    it.only('Can claim for 5 cw20 and 5 cw721 addresses', async () => {
        const contracts: Cw20Token[] = [];
        const letters = ['a', 'b', 'c', 'd', 'e']
        for (let i = 0; i < 5; i++) {
            contracts.push(await deployer.deployCw20('./precompiles_test/store/cw20_base.wasm', {
                name: `Test${letters[i]}`,
                symbol: `TEST${letters[i]}`,
                decimals: 6,
                mint: {
                    minter: admin.seiAddress,
                },
                initial_balances: [
                    {address: admin.seiAddress, amount: "10000000"},
                    {address: alice.seiAddress, amount: "30000000"}]
            }, `MYTest${letters[i]}`))
        }
        for (const contract of contracts) {
            await contract.mint(alice.seiAddress, '10000000');
            console.log(await contract.balanceOf(alice.seiAddress));
        }
        const recip = contracts.map(c => 'CW20 ' + c.getAddress());
        const {stdout} = await exec(`seid tx evm print-claim-specific ${bob.evmAddress} ${recip.join(' ')} --from alice --fees 24200usei -y`);
        const payloadArr = hex2uint8(stdout);
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        console.log('Done');
        for (const contract of contracts) {
            console.log(await contract.balanceOf(bob.seiAddress));
        }
    })
})

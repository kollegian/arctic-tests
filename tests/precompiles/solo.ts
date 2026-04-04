import {SeiUser, UserFactory} from "../../shared/User";
import {Cw1155Token, Cw20Token, Cw721Token, Erc20Token, Erc721Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import {ethers} from "ethers";
import soloAbi from "./abis/solo_abi.json"
import {expect} from "chai";
import * as util from "node:util";
import {exec as execCallback} from "node:child_process";
import {execCommandAndReturnJson, getSoloAllPayload, getSoloPayload} from "../../shared/utils/cliUtils";
import { Encoder } from "@sei-js/cosmos/encoding";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
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
    let soloContract: ethers.Contract;
    let deployer: TokenDeployer;
    const cw155TokenId = '15031';
    const singleNftId = '16031';
    const nftStartId = 15530;
    const laterMints = 17540;
    const laterMultipleMints = 18660;

    before('Deploys all contracts', async () => {
        admin = await UserFactory.createAdminUser();
        // await UserFactory.fundAdminOnSei();
        console.log(admin.evmWallet.wallet.privateKey);
        alice = await UserFactory.createSeiUser(admin, 'alice');
        console.log(alice.evmWallet.wallet.privateKey);
        console.log(alice.evmAddress);
        bob = await UserFactory.createSeiUser(admin, 'bob');
        console.log(bob.evmAddress);
        deployer = new TokenDeployer(admin);
        /*cw20 = await deployer.deployCw20('./wasm_store/cw20_base.wasm', {
            name: "Test",
            symbol: "TEST",
            decimals: 6,
            mint: {
                minter: admin.seiAddress,
            },
            initial_balances: [
                {address: admin.seiAddress, amount: "10000000"},
                {address: bob.seiAddress, amount: "30000000"}]
        }, 'MYTest');*/
        /*erc20 = await deployer.deployErc20();
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
        }, 'MyTest');*/
        // soloContract = new ethers.Contract('0x000000000000000000000000000000000000100C', soloAbi, admin.evmWallet.wallet);
        cw20 = new Cw20Token(admin, 'sei1t8xjfyzvma2xldkz2umc2cux9weayc58m8yz6hwxu9dree4k92zstw2hm8');
        erc20 = new Erc20Token(admin, '0xf97313ddEe90bdDAc23A453c794A6a83A2fB7f9d');
        erc721 = new Erc721Token(admin, '0x92534F6eDe27ceeF415009405a6d5A184B818F6f');
        cw721 = new Cw721Token(admin, 'sei127znsqfnrjvp6dfx3teqsr6zuh8n7h585payp4kf8xvmcagqd4sqfucu7j');
        cw1155 = new Cw1155Token(admin, 'sei1gw5vmme8q9tq9wgtz6n822kzp2tlq56m7ej8qk8w90lmhuyq4d8sgmhg4j');
        soloContract = new ethers.Contract('0x000000000000000000000000000000000000100C', soloAbi, admin.evmWallet.wallet);
        await cw20.mint(bob.seiAddress, '30000000');
        await cw20.mint(admin.seiAddress, '10000000');
    });

    it.only('Given that a user has cw20 tokens, they can transfer all with solo to an evm address before pointers', async () => {
        const userBalance = await cw20.balanceOf(admin.seiAddress);
        const pointer = await cw20.deployPointer(admin.evmRpcEndpoint);
        await waitFor(1);
        const pointerAddress = await cw20.queryPointerAddress();
        const pointerErc20 = new Erc20Token(admin, pointerAddress);
        const preBalance = await pointerErc20.balanceOf(alice.evmAddress);
        console.log(preBalance);
        const payload = await getSoloPayload('admin', alice.evmAddress, 'CW20', cw20.getAddress());
        const payloadArry = hex2uint8(payload);
        const tx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await tx.wait();
        const afterBalanceFromPointer = await pointerErc20.balanceOf(alice.evmAddress);
        console.log(afterBalanceFromPointer);
        const afterBalance = await cw20.balanceOf(admin.seiAddress);
        expect(Number(afterBalance)).to.equal(0);
        const aliceBalance = await cw20.balanceOf(alice.seiAddress);
        console.log(aliceBalance);
        expect(aliceBalance).to.equal(userBalance);
    });

    it('Allowances dont carry over', async () => {
        cw20.setSigner(bob);
        await cw20.approve(admin.seiAddress, '10000000');
        const allowance = await cw20.allowance(bob.seiAddress, admin.seiAddress);
        const payload = await getSoloPayload('bob', alice.evmAddress, 'CW20', cw20.getAddress());
        const payloadArry = hex2uint8(payload);
        const tx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await tx.wait();
        const afterBalance = await cw20.balanceOf(alice.seiAddress);
        expect(Number(afterBalance)).to.equal(40000000);
        const aliceBalance = await cw20.balanceOf(bob.seiAddress);
        expect(Number(aliceBalance)).to.equal(0);

        const afterAllowance = await cw20.allowance(bob.seiAddress, admin.seiAddress);
    });

    it('Can be sent to multiple addresses from same user', async () => {
        // alice has 40000000
        const payload = await getSoloPayload('alice', bob.evmAddress, 'CW20', cw20.getAddress());
        const payloadArry = hex2uint8(payload);
        const tx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await tx.wait();
        const aliceBalance = await cw20.balanceOf(alice.seiAddress);
        expect(Number(aliceBalance)).to.equal(0);
        const bobBalance = await cw20.balanceOf(bob.seiAddress);
        expect(Number(bobBalance)).to.equal(40000000);
    })

    it('After deploying pointers users will be able to claim again for cw20', async () => {
        const preBalance = await cw20.balanceOf(admin.seiAddress);
        expect(Number(preBalance)).to.equal(0);
        cw20.setSigner(admin);
        const mintTx = await cw20.mint(admin.seiAddress, '10000000');
        const afterMintBalance = await cw20.balanceOf(admin.seiAddress);
        expect(afterMintBalance).to.be.eq('10000000');
        const pointer = await cw20.deployPointer(admin.evmRpcEndpoint);
        await waitFor(2);
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

    it('Given that a user has cw721 token, they can transfer with solo to an evm address', async () => {
        const tx = await cw721.mintTx(singleNftId, admin.seiAddress);
        const owner = await cw721.ownerOf(singleNftId);
        expect(owner).to.equal(admin.seiAddress);
        const payload = await getSoloPayload('admin', alice.evmAddress, 'CW721', cw721.getAddress());
        const payloadArry = hex2uint8(payload);
        const claimTx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await claimTx.wait();
        const ownerAfter = await cw721.ownerOf(singleNftId);
        expect(ownerAfter).to.equal(alice.seiAddress);
    });

    it('Transfers royalty information as well', async () => {
        const tokenInfo = await cw721.queryRoyaltyInfo(singleNftId, '10000000');
        expect(tokenInfo.address).to.equal(admin.seiAddress);
        expect(tokenInfo.royalty_amount).to.equal('1000000');
    });

    it('Given that a user has multiple nft minted from same contract, claim specific moves all tokens', async () => {
        await cw721.mintTx((nftStartId + 1).toString(), bob.seiAddress);
        await cw721.mintTx((nftStartId + 2).toString(), bob.seiAddress);
        await cw721.mintTx((nftStartId + 3).toString(), bob.seiAddress);
        await cw721.mintTx((nftStartId + 4).toString(), bob.seiAddress);
        cw721.setSigner(bob);
        const allowanceTx = await cw721.approve(admin.seiAddress, (nftStartId + 4).toString());
        const payload = await getSoloPayload('bob', alice.evmAddress, 'CW721', cw721.getAddress());
        const payloadArry = hex2uint8(payload);
        const claimTx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await claimTx.wait();
        const ownerAfter = await cw721.ownerOf((nftStartId + 2).toString());
        expect(ownerAfter).to.equal(alice.seiAddress);
        const ownerAfter2 = await cw721.ownerOf((nftStartId + 3).toString());
        expect(ownerAfter2).to.equal(alice.seiAddress);
        const ownerAfter3 = await cw721.ownerOf((nftStartId + 4).toString());
        expect(ownerAfter3).to.equal(alice.seiAddress);
    });

    it('Given that a user has allowance set, transferring removes approvals', async () => {
        const allowance = await cw721.queryApprovals(nftStartId + 4);
        expect(allowance.approvals).to.have.lengthOf(0);
    });

    it.skip('Users cant use solo to transfer from erc pointer contracts', async () => {
        const pointerAddr = await erc20.deployPointer(admin.evmRpcEndpoint);
        const pointerCw20 = new Cw20Token(admin, pointerAddr);
        const aliceTx = await erc20.contract.setBalance(alice.evmAddress, ethers.parseEther('10').toString());
        await aliceTx.wait();
        const pointerBalance = await pointerCw20.balanceOf(alice.seiAddress);
        expect(pointerBalance).to.equal(ethers.parseEther('10'));
        const payload = await getSoloPayload('alice', admin.evmAddress, 'ERC20', pointerAddr);
        const payloadArry = hex2uint8(payload);
        const claimTx = await soloContract.connect(admin.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await claimTx.wait();
        const pointerBalanceAfter = await pointerCw20.balanceOf(alice.seiAddress);
        expect(pointerBalanceAfter).to.equal(ethers.parseEther('10'));
    });

    it.skip('Given that a user has a bunch of cw1155 tokens, they can transfer all with solo to an evm address', async () => {
        const amount = 100;
        const tokenUri = 'uri1';

        await cw1155.mint({
            recipient: alice.seiAddress,
            tokenId: cw155TokenId,
            amount: amount,
            tokenUri: tokenUri,
        });

        const balance = await cw1155.balanceOf(alice.seiAddress, cw155TokenId);
        console.log(balance);
        const payload = await getSoloPayload('alice', admin.evmAddress, 'CW1155', cw1155.getAddress());
        const payloadArry = hex2uint8(payload);
        const claimTx = await soloContract.connect(admin.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        const receipt = await claimTx.wait();
        console.log('Sent');
        const balanceAfter = await cw1155.balanceOf(alice.seiAddress, cw155TokenId);
        expect(balanceAfter).to.equal(0);
        const balanceRecvrAfter = await cw1155.balanceOf(admin.seiAddress, cw155TokenId);
        expect(balanceRecvrAfter).to.equal(amount);
    });

    it('Works with usei balance', async () => {
        const newUser = await UserFactory.createUnassociatedUsers(admin, 'eva', true);
        await UserFactory.fundAddressOnSei(newUser.seiAddress, 'usei', '1000000');
        await newUser.seiWallet.associate();
        const newUserBalance = await newUser.seiWallet.queryBalance();

        //after association user should have over 0.9 sei
        expect(Number(newUserBalance.amount)).to.be.gt(900000);

        const payload = await getSoloAllPayload('eva', alice.evmAddress);
        const payloadArr = hex2uint8(payload);
        const alicePreBalance = await alice.evmWallet.queryBalance();

        const claimTx = await soloContract.connect(alice.evmWallet.wallet).claim(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();

        const balance = await newUser.seiWallet.queryBalance();
        expect(Number(balance.amount)).to.be.eq(0);
        const alicePostBalance = await alice.evmWallet.queryBalance();
        expect(Number(alicePostBalance - alicePreBalance)).to.be.gt(900000)
    });

    it('Vested balances fails', async () => {
        const newUser = await UserFactory.createUnassociatedUsers(admin, 'dave', true);
        const currentTime = Math.floor(Date.now() / 1000);
        const endTime = currentTime + 600;
        const res = await execCommandAndReturnJson(`seid tx vesting create-vesting-account ${newUser.seiAddress} 1000000usei ${endTime} --from admin --fees 24200usei -y`);
        await newUser.seiWallet.associate();
        await UserFactory.fundAddressOnSei(newUser.seiAddress, 'usei', '1000000');
        //now user has 2 sei 1 vested and locked
        const senderBalancePre = await newUser.seiWallet.queryBalance();
        const recvrBalancePre = await admin.seiWallet.queryBalance();
        const payload = await getSoloAllPayload('dave', admin.evmAddress);
        const payloadArr = hex2uint8(payload);
        try {
            const claimTx = await soloContract.connect(admin.evmWallet.wallet).claim(payloadArr, {gasLimit: 1000000});
            await claimTx.wait();
            throw new Error('Should have failed');
        } catch (e: any) {
            expect(e.message).to.not.contain('Should have failed');
        }
        const recvrBalanceAfter = await admin.seiWallet.queryBalance();
        //verifies that balance is decreased and not increased
        expect(Number(recvrBalanceAfter.amount)).to.be.lt(Number(recvrBalancePre.amount));
        const senderBalanceAfter = await newUser.seiWallet.queryBalance();
        expect(JSON.stringify(senderBalanceAfter)).to.equal(JSON.stringify(senderBalancePre));
    });

    let denomName: string;
    it('Given that a user has tokenfactory denoms they should be able to be claimed', async () => {
        const tokenFactoryDenom = await execCommandAndReturnJson(`seid tx tokenfactory create-denom mydenom --from alice --fees 24200usei -y`);
        denomName = `factory/${alice.seiAddress}/mydenom`;
        await waitFor(0.5);
        const out = await execCommandAndReturnJson(`seid tx tokenfactory mint 10000000${denomName} --from alice --fees 24200usei -y`);
        await waitFor(1);
        const tokenBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom ${denomName} --output json`);
        expect(tokenBalance.amount).to.equal('10000000');
        const senderSeiBalancePre = await alice.seiWallet.queryBalance();
        const payload = await getSoloAllPayload('alice', admin.evmAddress);
        const payloadArr = hex2uint8(payload);
        const claimTx = await soloContract.connect(admin.evmWallet.wallet).claim(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();

        const recvrBalance = await execCommandAndReturnJson(`seid q bank balances ${admin.seiAddress} --denom ${denomName} --output json`);
        expect(recvrBalance.amount).to.equal('10000000');
        const senderBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom ${denomName} --output json`);
        expect(senderBalance.amount).to.equal('0');

        //Should send sei alongside
        const senderSeiBalanceAfter = await alice.seiWallet.queryBalance();
        expect(Number(senderSeiBalanceAfter.amount)).to.be.eq(0);
    });

    it('Given that a user has tokenfactory, cw20 and cw721 balances, claim should only claim native tokens', async () => {
        //need to fund alice again
        await UserFactory.fundAddressOnSei(alice.seiAddress, 'usei', '1000000');
        await execCommandAndReturnJson(`seid tx tokenfactory mint 10000000${denomName} --from alice --fees 24200usei -y`);
        const alicePreSeiBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom usei --output json`);
        const alicePreTokenBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom ${denomName} --output json`);
        cw20.setSigner(admin);
        cw721.setSigner(admin);
        await cw20.mint(alice.seiAddress, '10000000');
        await cw721.mintTx((laterMints + 1).toString(), alice.seiAddress);
        await cw721.mintTx((laterMints + 2).toString(), alice.seiAddress);
        const alicePreBalanceCw20 = await cw20.balanceOf(alice.seiAddress);
        expect(alicePreBalanceCw20).to.equal('20000000');
        expect(Number(alicePreSeiBalance.amount)).to.be.gt(900000);
        expect(Number(alicePreTokenBalance.amount)).to.be.eq(10000000);
        const bobPreSeiBalance = await bob.seiWallet.queryBalance();
        const bobPreBalanceCw20 = await cw20.balanceOf(bob.seiAddress);
        const bobTokenDenomBalance = await execCommandAndReturnJson(`seid q bank balances ${bob.seiAddress} --denom ${denomName} --output json`);

        const payload = await getSoloAllPayload('alice', bob.evmAddress);
        const payloadArr = hex2uint8(payload);
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claim(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        await waitFor(1);
        const bobTokenDenomAfterBalance = await execCommandAndReturnJson(`seid q bank balances ${bob.seiAddress} --denom ${denomName} --output json`);
        expect(Number(bobTokenDenomAfterBalance.amount)).to.be.eq(10000000);
        const bobAfterBalanceSei = await execCommandAndReturnJson(`seid q bank balances ${bob.seiAddress} --denom usei --output json`);
        expect(Number(bobAfterBalanceSei.amount)).to.be.gt(Number(bobPreSeiBalance.amount));
        const bobAfterCw20Balance = await cw20.balanceOf(bob.seiAddress);
        expect(Number(bobAfterCw20Balance)).to.be.eq(Number(bobPreBalanceCw20));
        const nftOwnership = await cw721.ownerOf((laterMints + 1).toString());
        expect(nftOwnership).to.equal(alice.seiAddress);
        const nftOwnership2 = await cw721.ownerOf((laterMints + 2).toString());
        expect(nftOwnership2).to.equal(alice.seiAddress);

        //verify alice balances are all zero now
        const aliceBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom usei --output json`);
        expect(Number(aliceBalance.amount)).to.be.eq(0);
        const aliceTokenBalance = await execCommandAndReturnJson(`seid q bank balances ${alice.seiAddress} --denom ${denomName} --output json`);
        expect(Number(aliceTokenBalance.amount)).to.be.eq(0);
        const aliceCw20Balance = await cw20.balanceOf(alice.seiAddress);
        expect(Number(aliceCw20Balance)).to.be.eq(20000000);
    });

    it('Given that a user has multiple cw20 balances', async () => {
        await UserFactory.fundAddressOnSei(alice.seiAddress, 'usei', '2000000');
        const newCw20 = await deployer.deployCw20('./wasm_store/cw20_base.wasm', {
            name: "Test",
            symbol: "TEST",
            decimals: 6,
            mint: {
                minter: admin.seiAddress,
            },
            initial_balances: [
                {address: admin.seiAddress, amount: "10000000"},
                {address: bob.seiAddress, amount: "30000000"}]
        }, 'MYTesttwo');

        const bobPreBalanceCw20 = await cw20.balanceOf(bob.seiAddress);
        const bobPreBalanceCw202 = await newCw20.balanceOf(bob.seiAddress);
        const alicePreBalanceCw20 = await cw20.balanceOf(alice.seiAddress);
        const {stdout} = await exec(`seid tx evm print-claim-specific ${alice.evmAddress} CW20 ${cw20.getAddress()} CW20 ${newCw20.getAddress()} --from bob --fees 24200usei -y`);
        const payloadArr = hex2uint8(stdout);
        const claimTx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        const aliceBalanceCw20 = await cw20.balanceOf(alice.seiAddress);
        const aliceBalanceCw202 = await newCw20.balanceOf(alice.seiAddress);
        expect(Number(aliceBalanceCw20)).to.equal(Number(bobPreBalanceCw20) + Number(alicePreBalanceCw20));
        expect(aliceBalanceCw202).to.equal(bobPreBalanceCw202);

        const bobAfterBalanceCw20 = await cw20.balanceOf(bob.seiAddress);
        const bobAfterBalanceCw202 = await newCw20.balanceOf(bob.seiAddress);
        expect(Number(bobAfterBalanceCw20)).to.equal(0);
        expect(Number(bobAfterBalanceCw202)).to.equal(0);
        await waitFor(5);
    });

    it('Given that a user has multiple cw721 balances', async () => {
        await cw721.mintTx(laterMultipleMints.toString(), alice.seiAddress);
        expect(await cw721.ownerOf(laterMultipleMints.toString())).to.equal(alice.seiAddress);
        const newCw721 = await deployer.deployCw721('./wasm_store/cw2981_royalties.wasm', {
            name: "Test",
            symbol: "TEST",
            minter: admin.seiAddress,
        }, 'MyTest');
        await waitFor(2);
        await newCw721.mintTx(laterMultipleMints.toString(), alice.seiAddress);
        expect(await newCw721.ownerOf(laterMultipleMints.toString())).to.equal(alice.seiAddress);

        const {stdout} = await exec(`seid tx evm print-claim-specific ${bob.evmAddress} CW721 ${cw721.getAddress()} CW721 ${newCw721.getAddress()} --from alice --fees 24500usei -y`);
        const payloadArr = hex2uint8(stdout);
        console.log('produced this one');
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 2000000});
        await claimTx.wait();

        const bobBalance = await cw721.ownerOf(laterMultipleMints.toString());
        expect(bobBalance).to.equal(bob.seiAddress);
        const bobBalance2 = await newCw721.ownerOf(laterMultipleMints.toString());
        expect(bobBalance2).to.equal(bob.seiAddress);
    });

    it('Given that a user has cw20 and cw721 balance', async () =>{
        await cw20.mint(alice.seiAddress, '10000000');
        await cw721.mintTx((laterMultipleMints + 1).toString(), alice.seiAddress);
        const bobPreBalance = await cw20.balanceOf(bob.seiAddress);

        const {stdout} = await exec(`seid tx evm print-claim-specific ${bob.evmAddress} CW20 ${cw20.getAddress()} CW721 ${cw721.getAddress()} --from alice --fees 24200usei -y`);
        const payloadArr = hex2uint8(stdout);
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        const bobBalance = await cw20.balanceOf(bob.seiAddress);
        expect(Number(bobBalance)).to.equal(Number(bobPreBalance) + Number('10000000'));
        expect(await cw721.ownerOf((laterMultipleMints + 1).toString())).to.equal(bob.seiAddress);
        expect(await cw20.balanceOf(alice.seiAddress)).to.equal('0');
    });

    it('Given that a user has 0 balance on cw20 but valid balance on cw721', async () =>{
        await cw721.mintTx((laterMultipleMints + 2).toString(), alice.seiAddress);
        const {stdout} = await exec(`seid tx evm print-claim-specific ${bob.evmAddress} CW20 ${cw20.getAddress()} CW721 ${cw721.getAddress()} --from alice --fees 24200usei -y`);
        const bobPreBalance = await cw20.balanceOf(bob.seiAddress);
        const payloadArr = hex2uint8(stdout);
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        const bobBalance = await cw20.balanceOf(bob.seiAddress);
        expect(bobBalance).to.eq(bobPreBalance)
        expect(await cw721.ownerOf((laterMultipleMints + 2).toString())).to.equal(bob.seiAddress);
    });

    it('Can claim for 5 cw20 addresses', async () => {
        const contracts: Cw20Token[] = [];
        const letters = ['a', 'b', 'c', 'd', 'e']
        for (let i = 0; i < 5; i++) {
            contracts.push(await deployer.deployCw20('./wasm_store/cw20_base.wasm', {
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
        const recip = contracts.map(c => 'CW20 ' + c.getAddress());
        const {stdout} = await exec(`seid tx evm print-claim-specific ${bob.evmAddress} ${recip.join(' ')} --from alice --fees 24200usei -y`);
        const payloadArr = hex2uint8(stdout);
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        console.log('Done');
        for (const contract of contracts) {
            expect(await contract.balanceOf(bob.seiAddress)).to.equal('30000000');
        }
    });

    it('Only Bob can claim what is signed by Alice', async () =>{
        await cw721.mintTx((laterMultipleMints + 3).toString(), alice.seiAddress);
        const {stdout} = await exec(`seid tx evm print-claim-specific ${bob.evmAddress} CW20 ${cw20.getAddress()} CW721 ${cw721.getAddress()} --from alice --fees 24200usei -y`);
        const payloadArr = hex2uint8(stdout);
        try{
            const claimTx = await soloContract.connect(admin.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
            await claimTx.wait();
            throw new Error('Should have failed');
        } catch (e: any){
            expect(e.message).to.not.eq('Should have failed');
        }

        //verify nothing happened and Alice is still the owner
        expect(await cw721.ownerOf((laterMultipleMints + 3).toString())).to.equal(alice.seiAddress);

        //Now bob claims it
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claimSpecific(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();
        expect(await cw721.ownerOf((laterMultipleMints + 3).toString())).to.equal(bob.seiAddress);
    });

    it('Claiming have no effect on erc side', async () => {
        const erc20MintAmount = ethers.parseEther('1').toString();
        const erc721TokenId = laterMultipleMints + 4;
        const adminErc20Pre = await erc20.balanceOf(admin.evmAddress);
        await erc20.mint(admin.evmAddress, erc20MintAmount);
        const tx = await erc721.safeMint(admin.evmAddress, erc721TokenId.toString());
        await tx.wait();

        const adminErc20BeforeClaim = await erc20.balanceOf(admin.evmAddress);
        const erc721OwnerBeforeClaim = await erc721.ownerOf(erc721TokenId.toString());

        // Mint a CW721 to admin on Sei and claim it to Alice
        const cw721Id = (laterMultipleMints + 4).toString();
        await cw721.mintTx(cw721Id, admin.seiAddress);
        expect(await cw721.ownerOf(cw721Id)).to.equal(admin.seiAddress);

        const payload = await getSoloPayload('admin', alice.evmAddress, 'CW721', cw721.getAddress());
        const payloadArry = hex2uint8(payload);
        const claimTx = await soloContract.connect(alice.evmWallet.wallet).claimSpecific(payloadArry, {gasLimit: 1000000});
        await claimTx.wait();

        // CW721 moved to Alice
        expect(await cw721.ownerOf(cw721Id)).to.equal(alice.seiAddress);

        // ERC20 and ERC721 on EVM remain with admin
        const adminErc20After = await erc20.balanceOf(admin.evmAddress);
        const erc721OwnerAfter = await erc721.ownerOf(erc721TokenId);
        expect(adminErc20After).to.equal(adminErc20BeforeClaim);
        expect(erc721OwnerAfter).to.equal(admin.evmAddress);
    });

    it('Claim (all) has no effect on erc assets', async () => {
        // Ensure Alice has ERC balances on EVM
        const erc20MintAmount = ethers.parseEther('2').toString();
        const erc721TokenId = laterMultipleMints + 5;

        await erc20.mint(alice.evmAddress, erc20MintAmount);
        const tx = await erc721.safeMint(alice.evmAddress, erc721TokenId);
        await tx.wait();
        const aliceErc20Pre = await erc20.balanceOf(alice.evmAddress);
        const aliceErc721OwnerPre = await erc721.ownerOf(erc721TokenId);

        // Fund Alice with native to make claim (all) do something
        await UserFactory.fundAddressOnSei(alice.seiAddress, 'usei', '1000000');

        const payload = await getSoloAllPayload('alice', bob.evmAddress);
        const payloadArr = hex2uint8(payload);
        const claimTx = await soloContract.connect(bob.evmWallet.wallet).claim(payloadArr, {gasLimit: 1000000});
        await claimTx.wait();

        // ERC balances should be unchanged
        const aliceErc20After = await erc20.balanceOf(alice.evmAddress);
        const aliceErc721OwnerAfter = await erc721.ownerOf(erc721TokenId);
        expect(aliceErc20After).to.equal(aliceErc20Pre);
        expect(aliceErc721OwnerAfter).to.equal(alice.evmAddress);
    });

    it.only('Cannot forge claim for another user (chain validates signature)', async () => {
        // Preconditions: Give Bob some CW20 and CW721 on Sei so there is something to steal
        cw20.setSigner(admin);
        await cw20.mint(bob.seiAddress, '5000000');
        await cw721.mintTx((laterMultipleMints + 6).toString(), bob.seiAddress);

        // Alice attempts to craft a MsgClaimSpecific with sender=bob but signs with Alice's key
        const assets = [
            {assetType: 1, contractAddress: cw20.getAddress()},   // CW20
            {assetType: 2, contractAddress: cw721.getAddress()},  // CW721
        ];

        const forgedMsg = Encoder.evm.MsgClaimSpecific.fromPartial({
            sender: bob.seiAddress,
            claimer: admin.evmAddress,
            assets: assets.map(a => {
                    return {
                        asset_type: a.assetType,
                        contract_address: a.contractAddress,
                }
            }),
        });
        const msg = {
            typeUrl: `/${Encoder.evm.MsgClaimSpecific.$type}`,
            value: forgedMsg,
        } as const;

        const {accountNumber, sequence} = await alice.seiWallet.signingClient.getSequence(alice.seiAddress);
        const chainId = await alice.seiWallet.signingClient.getChainId();
        const fee = {amount: [{denom: "usei", amount: "50000"}], gas: "200000"};

        // Sign with Alice (NOT Bob) for a message that claims to be from Bob
        const txRaw: TxRaw = await alice.seiWallet.signingClient.sign(
            alice.seiAddress,
            [msg],
            fee,
            "",
            {accountNumber, sequence, chainId}
        );

        const txBytes = TxRaw.encode(txRaw).finish();
        const invalidhexString = Buffer.from(txBytes).toString('hex');
        const invalidPayload = hex2uint8(invalidhexString);
        // Try to execute through the Solo precompile – should revert due to invalid signature vs sender
        try {
            const claimTx = await soloContract.connect(admin.evmWallet.wallet).claimSpecific(invalidPayload, {gasLimit: 1000000});
            await claimTx.wait();
            throw new Error('Should have failed with invalid signature');
        } catch (e: any) {
            console.log(e.message);
            expect(e.message).to.not.contain('Should have failed with invalid signature');
        }

        // Sanity: balances/ownership remain unchanged
        const bobCw20After = await cw20.balanceOf(bob.seiAddress);
        expect(Number(bobCw20After)).to.be.gte(5000000);
        expect(await cw721.ownerOf((laterMultipleMints + 6).toString())).to.equal(bob.seiAddress);

        // Now construct a valid claim signed by Bob and verify it succeeds
        const {accountNumber: bobAcc, sequence: bobSeq} = await bob.seiWallet.signingClient.getSequence(bob.seiAddress);
        const bobChainId = await bob.seiWallet.signingClient.getChainId();
        const validMsg = {
            typeUrl: `/${Encoder.evm.MsgClaimSpecific.$type}`,
            value: Encoder.evm.MsgClaimSpecific.fromPartial({
                sender: bob.seiAddress,
                claimer: admin.evmAddress,
                assets: assets.map(a => {
                    return {
                        asset_type: a.assetType,
                        contract_address: a.contractAddress,
                    };
                })
            })
        }

        const validTxRaw: TxRaw = await bob.seiWallet.signingClient.sign(
            bob.seiAddress,
            [validMsg],
            fee,
            "",
            {accountNumber: bobAcc, sequence: bobSeq, chainId: bobChainId}
        );


        const validBytes = TxRaw.encode(validTxRaw).finish();
        const hexString = Buffer.from(validBytes).toString('hex');
        console.log(hexString);
        console.log('****');
        const {stdout} = await exec(`seid tx evm print-claim-specific ${admin.evmAddress} CW20 ${cw20.getAddress()} CW721 ${cw721.getAddress()} --from bob --fees 24200usei -y`);
        console.log(stdout);
        const payloadArray = hex2uint8(hexString);
        const okTx = await soloContract.connect(admin.evmWallet.wallet).claimSpecific(payloadArray, { gasLimit: 1000000 });
        await okTx.wait();
    });
})

import {Cw20Token, Cw721Token, Erc20Token, Erc721Token} from "../../shared/Token";
import {SeiUser, UserFactory} from "../../shared/User";
import {CW20ERC20Pointer} from "../../typechain-types";
import {ethers} from "ethers";
import {EvmRpcClient} from "../../shared/RpcClient";
import {expect} from "chai";
import * as abi from "../../artifacts/contracts/TestERC1155.sol/TestERC1155.json";
describe('@state-required Tests', function () {
    this.timeout(3 * 60 * 1000);
    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let eve: SeiUser;
    let cw20: Cw20Token;
    let pointerCw20: Erc20Token;

    let erc20: Erc20Token;
    let pointerErc20: Cw20Token;

    let cw721Token: Cw721Token;
    let pointerCw721: Erc721Token;

    let erc721Token: Erc721Token;
    let pointerErc721: Cw721Token;

    let evmRpcClient: EvmRpcClient;

    before('Initialize', async () => {
        admin = await UserFactory.createAdminUser();
        ([alice, bob, eve] = await UserFactory.createSeiUsers(admin, 2, true));
        console.log(alice.seiAddress);
        cw20 = new Cw20Token(admin, "sei1euqmngymytlt8j707spv9hn6ajzy92ndfjk47pnlu9uzmfuyplhssha74n");
        pointerCw20 = new Erc20Token(admin, '0x7D4B7B8CA7E1a24928Bb96D59249c7a5bd1DfBe6');

        erc20 = new Erc20Token(admin, '0x8ecE847ca9E74ca6e62e35a6210Ac44c4Ca31F90');
        pointerErc20 = new Cw20Token(admin, 'sei1n8ze4phtshhlucclf2hkrxs3u29gtyv2cc9v5ld8fu7en6838caqjtes6q');

        cw721Token = new Cw721Token(admin, 'sei1sslrhe0vthvnykwp2gz89rxx0kuaghstrpm6mtvfj6qszppd5g2qr0tm7a');
        pointerCw721 = new Erc721Token(admin, '0x7168634Dd1ee48b1C5cC32b27fD8Fc84E12D00E6');

        erc721Token = new Erc721Token(admin, '0xAb1eE548682F96f016467690975037f4851552a8');
        pointerErc721 = new Cw721Token(admin, 'sei1yrnh5d60cp5tctt8ngv626u7g3ejkmmecc92etjt2wue5ff9wxsqpul6z0');

        evmRpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
    });

    it('First query existing allowances ', async () => {
        const topic = ethers.id('Approval(address,address,uint256)')
        const logs = {
            fromBlock: ethers.toQuantity(1),
            toBlock: 'latest',
            address: erc20.getAddress(),
            topics: [topic],
        }
        const rpcRes = await evmRpcClient.getLogs(logs);
        console.log(rpcRes);
    });

    it('After upgrade users can still query balances', async () => {
        const cw20Balance = await cw20.balanceOf(alice.seiAddress);
        const cw20PointerBalance = await pointerCw20.balanceOf(alice.evmAddress);
        //alice balance on cw20 is 1708900

        expect(cw20Balance).to.equal('1708900');
        console.log(cw20PointerBalance);

        const allowances = await cw20.allowance(alice.seiAddress, bob.seiAddress);
        console.log(allowances);
        //alice bob allowance is 500
        cw721Token.setSigner(alice);
        // const nftAllowance = await cw721Token.mintTx("200", alice.seiAddress);
        // const allowEve = await cw721Token.approve(eve.seiAddress, "200");
        const allowance = await cw721Token.queryApprovals(200);
        // 200 nft is set to eve
        console.log(allowance);
        console.log(eve.seiAddress);
        console.log(allowance);

        const queryApproval = await pointerCw721.getApproved(200);
        // console.log(queryApproval);

        /*const mintTx = await erc721Token.contract.connect(alice.evmWallet.wallet).safeMint(alice.evmAddress, "200");
        await mintTx.wait();
        const allowanceTx = await erc721Token.contract.connect(alice.evmWallet.wallet).approve(bob.evmAddress, "200");
        await allowanceTx.wait();*/
        const approvals = await erc721Token.getApproved(200);
        // to the bob.evm address
        console.log(approvals);

        const pointerApproval = await pointerErc721.queryApprovals(200);
        console.log(pointerApproval);
        console.log(bob.evmAddress);
        console.log(bob.seiAddress);

        const balance = await erc20.balanceOf(alice.evmAddress);
        console.log(balance);
        // 500000000000000000000n

        // const tx = await erc20.contract.connect(alice.evmWallet.wallet).approve(bob.evmAddress, '500000000000000');
        // await tx.wait();
        const allownace = await erc20.allowance(alice.evmAddress, bob.evmAddress);
        //allowance is 500000000000000
        console.log(allownace);
    });

    it('Can interact with existing cw20 contract', async () =>{

    })

    it('cw1155 tests ', async () => {

        const query = {
            balance_of: {
                owner: alice.seiAddress,
                token_id: '1',
            },
        };

        const result: any = await alice.seiWallet.cosmWasmSigningClient.queryContractSmart(
            'sei1s4jwm729da3u9hr9vej8mw65uuzzwvwrdnp6l0rk73m0xef2grzq9clu8m',
            query
        );
        // 265 token

        console.log(result);
        const contract = new ethers.Contract('0x2118f39DB4a32327523eA9ED6299EE5E2dee7b3d', abi.abi, alice.evmWallet.wallet);
        /*const approveMsg = {
            approve_all: {
                operator: eve.seiAddress,
            },
        };
        await alice.seiWallet.cosmWasmSigningClient.execute(
            alice.seiAddress,
            'sei1s4jwm729da3u9hr9vej8mw65uuzzwvwrdnp6l0rk73m0xef2grzq9clu8m',
            approveMsg,
            'auto'
        );*/
        //true
        const allownace = await contract.isApprovedForAll(alice.evmAddress, eve.evmAddress);
        console.log(allownace);
    })


    it('After upgrade users can interact with contracts as before - ERC20', async () => {
        // user can use approval on wasm runtime
        const allowance = await erc20.allowance(alice.evmAddress, bob.evmAddress);
        console.log(allowance);
        pointerErc20.setSigner(bob);
        const bobPreBalance = await pointerErc20.balanceOf(bob.seiAddress);
        console.log(bobPreBalance);
        const bobPreBalanceEvm = await erc20.balanceOf(bob.evmAddress);
        console.log(bobPreBalanceEvm);
        console.log('*****');
        const alicePreBalanceWasm = await pointerErc20.balanceOf(alice.seiAddress);
        console.log(alicePreBalanceWasm);
        const alicePreBalanceEvm = await erc20.balanceOf(alice.evmAddress);
        console.log(alicePreBalanceEvm);
        console.log('Tx sent')

        const transferTx = await pointerErc20.transferFrom(alice.seiAddress, bob.seiAddress, '100000000');

        console.log(transferTx);

        const bobAfterBalanceWasm = await pointerErc20.balanceOf(bob.seiAddress);
        console.log(bobAfterBalanceWasm);
        const bobAfterBalanceEvm = await erc20.balanceOf(bob.evmAddress);
        console.log(bobAfterBalanceEvm);
        console.log('*****');
        const aliceAfterBalanceWasm = await pointerErc20.balanceOf(alice.seiAddress);
        console.log(aliceAfterBalanceWasm);
        const aliceAfterBalanceEvm = await erc20.balanceOf(alice.evmAddress);
        console.log(aliceAfterBalanceEvm);


    });

    it('Can check allowance and synthetic logs', async () =>{
        const allowance = await erc20.allowance(alice.evmAddress, bob.evmAddress);
        console.log(allowance);

        const logs = {
            fromBlock: ethers.toQuantity(48687),
            toBlock: ethers.toQuantity(48689),
            address: erc20.getAddress(),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        }
        const rpcRes = await evmRpcClient.getLogs(logs);
        console.log(rpcRes);

        const syntheticLogs = await evmRpcClient.sei_getLogs(logs);
        console.log(syntheticLogs);
    });

    it('User can transfer on evm runtime', async () => {
        const transferTx = await erc20.contract.connect(alice.evmWallet.wallet).transfer(bob.evmAddress, '100000000');
        const receipt = await transferTx.wait();
        console.log(receipt);
        const bobBalance = await erc20.balanceOf(bob.evmAddress);
        // existing balance here is: 200000000000100000000
        console.log(bobBalance);

        //existing balance here is 499999999999900000000
        const aliceBalance = await erc20.balanceOf(alice.evmAddress);
        console.log(aliceBalance);
        const aliceWasmBalance = await pointerErc20.balanceOf(alice.seiAddress);
        console.log(aliceWasmBalance);
    });

    it('Sei logs dont return whereas eth logs returns', async () =>{
        const logs = {
            fromBlock: ethers.toQuantity(50500),
            toBlock: ethers.toQuantity(50562),
            address: erc20.getAddress(),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        }

        const ethLogs = await evmRpcClient.getLogs(logs);
        console.log(ethLogs);

        const seiLogs = await evmRpcClient.sei_getLogs(logs);
        console.log(seiLogs);
    });

    it('After upgrade users can transfer on evm runtime', async () => {
        //erc721 stuff
        // nft id 200 is on bob allowance
        const ownership = await erc721Token.ownerOf(200);
        console.log(ownership);
        console.log(alice.seiAddress);
        const ownershipOnWasm = await pointerErc721.ownerOf('200');
        console.log(ownershipOnWasm);
        console.log(alice.evmAddress);
        console.log('*****');
        const allowance = await erc721Token.getApproved(200);

        const ownershipAfterTransfer = await erc721Token.ownerOf(200);
        console.log(ownershipAfterTransfer);
        console.log(eve.seiAddress);
        const ownershipOnWasmAfterTransfer = await pointerErc721.ownerOf('200');
        console.log(ownershipOnWasmAfterTransfer);
        console.log(eve.evmAddress);

        const allowanceAfterTransfer = await erc721Token.getApproved(200);
        console.log(allowanceAfterTransfer);
    });

    it('Eve transfers on evm runtime', async () =>{
        const transferTx = await erc721Token.contract.connect(eve.evmWallet.wallet).safeTransferFrom(eve.evmAddress, alice.evmAddress, '200');
        const receipt = await transferTx.wait();
        const owner = await erc721Token.ownerOf('200');
        console.log(owner);
        console.log(alice.evmAddress);
        const ownerOnWasm = await pointerErc721.ownerOf('200');
        console.log(ownerOnWasm);
        console.log(alice.seiAddress);
    });

    it('After upgrades users can transfer on sei runtime', async () => {
        const approveOnEvm = await erc721Token.contract.connect(alice.evmWallet.wallet).approve(bob.evmAddress, '200');
        const receipt = await approveOnEvm.wait();
        console.log(receipt);

        const approvalQuery = await erc721Token.getApproved('200');
        console.log(approvalQuery);

        const approvalOnWasm = await pointerErc721.queryApprovals('200');
        console.log(approvalOnWasm);
        console.log(bob.evmAddress);
        console.log(bob.seiAddress);
    });

    it('After upgrade users can use existing allowances on sei runtime', async () => {
        //approval height 54512
        pointerErc721.setSigner(bob);
        const wasmTx = await pointerErc721.safeTransferFrom(alice.seiAddress, bob.seiAddress, '200');
        console.log(wasmTx);

        // set another allowance
        const tx = await pointerErc721.approve(eve.seiAddress, '200');
        console.log(tx);
        const approval = await erc721Token.getApproved('200');
        console.log(approval);
        console.log(eve.evmAddress)
    });

    it('After upgrade users can use existing allowances on evm runtime', async () => {
        const logs = {
            fromBlock: ethers.toQuantity(54510),
            toBlock: ethers.toQuantity(54515),
            address: erc721Token.contract.target,
            topics: [ethers.id('Approval(address,address,uint256)')],
        }
        const result = await evmRpcClient.getLogs(logs);
        console.log(result);

        const response = await evmRpcClient.sei_getLogs(logs);
        console.log(response);
    });

    it('Queries approvals', async () => {
        const logs = {
            fromBlock: ethers.toQuantity(60151),
            toBlock: ethers.toQuantity(60152),
            address: erc721Token.contract.target,
            topics: [ethers.id('Approval(address,address,uint256)')],
        }

        const result = await evmRpcClient.getLogs(logs);
        console.log(result);

        const synth = await evmRpcClient.sei_getLogs(logs);
        console.log(synth);
    });

    it('Lets try transfer ', async () =>{
        const owner = await erc721Token.ownerOf('200');
        console.log(owner);
        console.log(alice.evmAddress);
        console.log(bob.evmAddress);
        console.log(eve.evmAddress);

        //owner is bob
        pointerErc721.setSigner(alice);
        const tx = await pointerErc721.safeTransferFrom(alice.seiAddress, bob.seiAddress, '200');
        console.log(tx);

        const owner2 = await erc721Token.ownerOf('200');
        console.log(owner2);
    });

    it('Users can grant new allowances on sei runtime', async () => {

    });

    it('Users can grant new allowances on evm runtime', async () => {

    });

    it('Users still can query info on sei runtime', async () => {

    });

    it('Users still can query info on evm runtime', async () => {

    });
})

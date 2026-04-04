import {Contract, ethers} from "ethers";
import {expect} from "chai";
import {SeiUser, UserFactory} from "../../shared/User";
import {TokenDeployer} from "../../shared/Deployer";
import {waitFor} from "../../shared/utils/helpers";
import {calculateFee} from "@cosmjs/stargate";
import fs from "fs";
import path from "path";
import wasmdAbi from "./abis/wasmd_abi.json";
import {WASM_PRECOMPILE_ADDRESS} from "./constants";

const WASM_FILE = "wasm_store/cw20_base.wasm";

describe("Wasm Precompile Tests", function () {
    this.timeout(5 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let wasmdContract: Contract;
    let cw20ContractAddress: string;
    let codeId: number;

    before("Initialize users, deploy CW20, and set up wasm precompile contract", async () => {
        admin = await UserFactory.createAdminUser();
        [alice, bob] = await UserFactory.createSeiUsers(admin, 2);

        wasmdContract = new Contract(WASM_PRECOMPILE_ADDRESS, wasmdAbi, admin.evmWallet.wallet);

        const uploadFee = calculateFee(10000000, "3.5usei");
        const wasm = fs.readFileSync(path.resolve(WASM_FILE));
        const uploadRes = await admin.seiWallet.cosmWasmSigningClient.upload(
            admin.seiAddress,
            wasm,
            uploadFee
        );
        codeId = uploadRes.codeId;
        console.log("Uploaded wasm code ID:", codeId);

        const deployer = new TokenDeployer(admin);
        const cw20 = await deployer.deployCw20(WASM_FILE, {
            name: "WasmPrecompileTest",
            symbol: "WPT",
            decimals: 6,
            initial_balances: [
                {address: admin.seiAddress, amount: "1000000000"},
                {address: alice.seiAddress, amount: "500000000"},
            ],
            mint: {minter: admin.seiAddress},
        }, "WasmPrecompileTestToken");
        cw20ContractAddress = cw20.getAddress();
        console.log("CW20 deployed at:", cw20ContractAddress);
    });

    describe("query()", function () {
        it("should query token info from CW20 contract", async () => {
            const queryMsg = {token_info: {}};
            const req = ethers.toUtf8Bytes(JSON.stringify(queryMsg));

            const responseBytes = await wasmdContract.query(cw20ContractAddress, req);
            const response = JSON.parse(ethers.toUtf8String(responseBytes));

            expect(response.name).to.eq("WasmPrecompileTest");
            expect(response.symbol).to.eq("WPT");
            expect(response.decimals).to.eq(6);
            expect(Number(response.total_supply)).to.be.gt(0);
        });

        it("should query balance of admin", async () => {
            const queryMsg = {balance: {address: admin.seiAddress}};
            const req = ethers.toUtf8Bytes(JSON.stringify(queryMsg));

            const responseBytes = await wasmdContract.query(cw20ContractAddress, req);
            const response = JSON.parse(ethers.toUtf8String(responseBytes));

            expect(Number(response.balance)).to.eq(1000000000);
        });

        it("should query balance of alice", async () => {
            const queryMsg = {balance: {address: alice.seiAddress}};
            const req = ethers.toUtf8Bytes(JSON.stringify(queryMsg));

            const responseBytes = await wasmdContract.query(cw20ContractAddress, req);
            const response = JSON.parse(ethers.toUtf8String(responseBytes));

            expect(Number(response.balance)).to.eq(500000000);
        });

        it("should return zero balance for an address with no tokens", async () => {
            const queryMsg = {balance: {address: bob.seiAddress}};
            const req = ethers.toUtf8Bytes(JSON.stringify(queryMsg));

            const responseBytes = await wasmdContract.query(cw20ContractAddress, req);
            const response = JSON.parse(ethers.toUtf8String(responseBytes));

            expect(Number(response.balance)).to.eq(0);
        });

        it("should fail to query a non-existent contract", async () => {
            const queryMsg = {token_info: {}};
            const req = ethers.toUtf8Bytes(JSON.stringify(queryMsg));
            let error = null;
            try {
                await wasmdContract.query("sei1nonexistentaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", req);
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it("should fail with an invalid query message", async () => {
            const req = ethers.toUtf8Bytes(JSON.stringify({invalid_query: {}}));
            let error = null;
            try {
                await wasmdContract.query(cw20ContractAddress, req);
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });
    });

    describe("execute()", function () {
        it("should execute a CW20 transfer from admin to bob", async () => {
            const preQueryMsg = {balance: {address: bob.seiAddress}};
            const preReq = ethers.toUtf8Bytes(JSON.stringify(preQueryMsg));
            const preResponseBytes = await wasmdContract.query(cw20ContractAddress, preReq);
            const preBalance = Number(JSON.parse(ethers.toUtf8String(preResponseBytes)).balance);

            const transferAmount = "100000";
            const executeMsg = {
                transfer: {
                    recipient: bob.seiAddress,
                    amount: transferAmount,
                },
            };
            const msg = ethers.toUtf8Bytes(JSON.stringify(executeMsg));
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            const tx = await wasmdContract.execute(cw20ContractAddress, msg, coins);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            await waitFor(1);

            const postReq = ethers.toUtf8Bytes(JSON.stringify(preQueryMsg));
            const postResponseBytes = await wasmdContract.query(cw20ContractAddress, postReq);
            const postBalance = Number(JSON.parse(ethers.toUtf8String(postResponseBytes)).balance);

            expect(postBalance).to.eq(preBalance + Number(transferAmount));
        });

        it("should execute a CW20 mint from admin (minter)", async () => {
            const mintAmount = "50000";
            const preQueryMsg = {balance: {address: bob.seiAddress}};
            const preReq = ethers.toUtf8Bytes(JSON.stringify(preQueryMsg));
            const preResponseBytes = await wasmdContract.query(cw20ContractAddress, preReq);
            const preBalance = Number(JSON.parse(ethers.toUtf8String(preResponseBytes)).balance);

            const executeMsg = {
                mint: {
                    recipient: bob.seiAddress,
                    amount: mintAmount,
                },
            };
            const msg = ethers.toUtf8Bytes(JSON.stringify(executeMsg));
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            const tx = await wasmdContract.execute(cw20ContractAddress, msg, coins);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            await waitFor(1);

            const postReq = ethers.toUtf8Bytes(JSON.stringify(preQueryMsg));
            const postResponseBytes = await wasmdContract.query(cw20ContractAddress, postReq);
            const postBalance = Number(JSON.parse(ethers.toUtf8String(postResponseBytes)).balance);

            expect(postBalance).to.eq(preBalance + Number(mintAmount));
        });

        it("should fail to execute transfer with insufficient balance", async () => {
            const executeMsg = {
                transfer: {
                    recipient: admin.seiAddress,
                    amount: "999999999999999",
                },
            };
            const msg = ethers.toUtf8Bytes(JSON.stringify(executeMsg));
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            let error = null;
            try {
                const aliceWasmd = new Contract(WASM_PRECOMPILE_ADDRESS, wasmdAbi, alice.evmWallet.wallet);
                const tx = await aliceWasmd.execute(cw20ContractAddress, msg, coins);
                await tx.wait();
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it("should fail to execute on a non-existent contract", async () => {
            const executeMsg = {transfer: {recipient: admin.seiAddress, amount: "100"}};
            const msg = ethers.toUtf8Bytes(JSON.stringify(executeMsg));
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            let error = null;
            try {
                const tx = await wasmdContract.execute(
                    "sei1nonexistentaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
                    msg,
                    coins
                );
                await tx.wait();
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it("should fail to mint from a non-minter address", async () => {
            const executeMsg = {
                mint: {
                    recipient: alice.seiAddress,
                    amount: "100",
                },
            };
            const msg = ethers.toUtf8Bytes(JSON.stringify(executeMsg));
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            let error = null;
            try {
                const aliceWasmd = new Contract(WASM_PRECOMPILE_ADDRESS, wasmdAbi, alice.evmWallet.wallet);
                const tx = await aliceWasmd.execute(cw20ContractAddress, msg, coins);
                await tx.wait();
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });
    });

    describe("execute_batch()", function () {
        it("should execute multiple CW20 transfers in a single batch", async () => {
            const aliceQueryMsg = {balance: {address: alice.seiAddress}};
            const bobQueryMsg = {balance: {address: bob.seiAddress}};

            const alicePreReq = ethers.toUtf8Bytes(JSON.stringify(aliceQueryMsg));
            const alicePreBytes = await wasmdContract.query(cw20ContractAddress, alicePreReq);
            const alicePreBalance = Number(JSON.parse(ethers.toUtf8String(alicePreBytes)).balance);

            const bobPreReq = ethers.toUtf8Bytes(JSON.stringify(bobQueryMsg));
            const bobPreBytes = await wasmdContract.query(cw20ContractAddress, bobPreReq);
            const bobPreBalance = Number(JSON.parse(ethers.toUtf8String(bobPreBytes)).balance);

            const transferToAlice = "10000";
            const transferToBob = "20000";
            const emptyCoins = ethers.toUtf8Bytes(JSON.stringify([]));

            const executeMsgs = [
                {
                    contractAddress: cw20ContractAddress,
                    msg: ethers.toUtf8Bytes(JSON.stringify({
                        transfer: {recipient: alice.seiAddress, amount: transferToAlice},
                    })),
                    coins: emptyCoins,
                },
                {
                    contractAddress: cw20ContractAddress,
                    msg: ethers.toUtf8Bytes(JSON.stringify({
                        transfer: {recipient: bob.seiAddress, amount: transferToBob},
                    })),
                    coins: emptyCoins,
                },
            ];

            const tx = await wasmdContract.execute_batch(executeMsgs);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            await waitFor(1);

            const alicePostReq = ethers.toUtf8Bytes(JSON.stringify(aliceQueryMsg));
            const alicePostBytes = await wasmdContract.query(cw20ContractAddress, alicePostReq);
            const alicePostBalance = Number(JSON.parse(ethers.toUtf8String(alicePostBytes)).balance);

            const bobPostReq = ethers.toUtf8Bytes(JSON.stringify(bobQueryMsg));
            const bobPostBytes = await wasmdContract.query(cw20ContractAddress, bobPostReq);
            const bobPostBalance = Number(JSON.parse(ethers.toUtf8String(bobPostBytes)).balance);

            expect(alicePostBalance).to.eq(alicePreBalance + Number(transferToAlice));
            expect(bobPostBalance).to.eq(bobPreBalance + Number(transferToBob));
        });

        it("should execute a batch with mint and transfer operations", async () => {
            const mintAmount = "30000";
            const transferAmount = "15000";
            const emptyCoins = ethers.toUtf8Bytes(JSON.stringify([]));

            const bobQueryMsg = {balance: {address: bob.seiAddress}};
            const bobPreReq = ethers.toUtf8Bytes(JSON.stringify(bobQueryMsg));
            const bobPreBytes = await wasmdContract.query(cw20ContractAddress, bobPreReq);
            const bobPreBalance = Number(JSON.parse(ethers.toUtf8String(bobPreBytes)).balance);

            const executeMsgs = [
                {
                    contractAddress: cw20ContractAddress,
                    msg: ethers.toUtf8Bytes(JSON.stringify({
                        mint: {recipient: admin.seiAddress, amount: mintAmount},
                    })),
                    coins: emptyCoins,
                },
                {
                    contractAddress: cw20ContractAddress,
                    msg: ethers.toUtf8Bytes(JSON.stringify({
                        transfer: {recipient: bob.seiAddress, amount: transferAmount},
                    })),
                    coins: emptyCoins,
                },
            ];

            const tx = await wasmdContract.execute_batch(executeMsgs);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            await waitFor(1);

            const bobPostReq = ethers.toUtf8Bytes(JSON.stringify(bobQueryMsg));
            const bobPostBytes = await wasmdContract.query(cw20ContractAddress, bobPostReq);
            const bobPostBalance = Number(JSON.parse(ethers.toUtf8String(bobPostBytes)).balance);

            expect(bobPostBalance).to.eq(bobPreBalance + Number(transferAmount));
        });

        it("should revert the entire batch if one message fails", async () => {
            const emptyCoins = ethers.toUtf8Bytes(JSON.stringify([]));

            const bobQueryMsg = {balance: {address: bob.seiAddress}};
            const bobPreReq = ethers.toUtf8Bytes(JSON.stringify(bobQueryMsg));
            const bobPreBytes = await wasmdContract.query(cw20ContractAddress, bobPreReq);
            const bobPreBalance = Number(JSON.parse(ethers.toUtf8String(bobPreBytes)).balance);

            const executeMsgs = [
                {
                    contractAddress: cw20ContractAddress,
                    msg: ethers.toUtf8Bytes(JSON.stringify({
                        transfer: {recipient: bob.seiAddress, amount: "100"},
                    })),
                    coins: emptyCoins,
                },
                {
                    contractAddress: cw20ContractAddress,
                    msg: ethers.toUtf8Bytes(JSON.stringify({
                        transfer: {recipient: bob.seiAddress, amount: "999999999999999"},
                    })),
                    coins: emptyCoins,
                },
            ];

            let error = null;
            try {
                const tx = await wasmdContract.execute_batch(executeMsgs);
                await tx.wait();
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;

            const bobPostReq = ethers.toUtf8Bytes(JSON.stringify(bobQueryMsg));
            const bobPostBytes = await wasmdContract.query(cw20ContractAddress, bobPostReq);
            const bobPostBalance = Number(JSON.parse(ethers.toUtf8String(bobPostBytes)).balance);

            expect(bobPostBalance).to.eq(bobPreBalance);
        });

        it("should handle an empty batch", async () => {
            let error = null;
            let succeeded = false;
            try {
                const tx = await wasmdContract.execute_batch([]);
                const receipt = await tx.wait();
                succeeded = receipt.status === 1;
            } catch (err: any) {
                error = err;
            }
            // Either a no-op success or a revert is acceptable
            expect(error !== null || succeeded).to.be.true;
        });
    });

    describe("instantiate()", function () {
        async function getLatestContractForCode(cId: number): Promise<string> {
            const contracts = await admin.seiWallet.cosmWasmSigningClient.getContracts(cId);
            return contracts[contracts.length - 1];
        }

        it("should instantiate a new CW20 contract via the precompile", async () => {
            const contractsBefore = await admin.seiWallet.cosmWasmSigningClient.getContracts(codeId);

            const initMsg = {
                name: "PrecompileInstantiated",
                symbol: "PCI",
                decimals: 6,
                initial_balances: [
                    {address: admin.seiAddress, amount: "500000000"},
                ],
                mint: {minter: admin.seiAddress},
            };
            const msg = ethers.toUtf8Bytes(JSON.stringify(initMsg));
            const label = "precompile-instantiated-cw20";
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            const tx = await wasmdContract.instantiate(
                codeId,
                admin.seiAddress,
                msg,
                label,
                coins
            );
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            await waitFor(1);

            const contractsAfter = await admin.seiWallet.cosmWasmSigningClient.getContracts(codeId);
            expect(contractsAfter.length).to.be.gt(contractsBefore.length);

            const newContractAddr = contractsAfter[contractsAfter.length - 1];
            expect(newContractAddr).to.be.a("string");
            expect(newContractAddr).to.match(/^sei1/);
        });

        it("should instantiate and then query the new contract", async () => {
            const initMsg = {
                name: "QueryTestToken",
                symbol: "QTT",
                decimals: 6,
                initial_balances: [
                    {address: admin.seiAddress, amount: "123456"},
                ],
                mint: {minter: admin.seiAddress},
            };
            const msg = ethers.toUtf8Bytes(JSON.stringify(initMsg));
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            const tx = await wasmdContract.instantiate(
                codeId,
                admin.seiAddress,
                msg,
                "query-test-cw20",
                coins
            );
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            await waitFor(1);

            const newAddr = await getLatestContractForCode(codeId);

            const queryMsg = {token_info: {}};
            const queryReq = ethers.toUtf8Bytes(JSON.stringify(queryMsg));
            const responseBytes = await wasmdContract.query(newAddr, queryReq);
            const response = JSON.parse(ethers.toUtf8String(responseBytes));

            expect(response.name).to.eq("QueryTestToken");
            expect(response.symbol).to.eq("QTT");
            expect(response.decimals).to.eq(6);
        });

        it("should fail to instantiate with an invalid code ID", async () => {
            const initMsg = {
                name: "InvalidCodeId",
                symbol: "ICI",
                decimals: 6,
                initial_balances: [],
            };
            const msg = ethers.toUtf8Bytes(JSON.stringify(initMsg));
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            let error = null;
            try {
                const tx = await wasmdContract.instantiate(
                    999999,
                    admin.seiAddress,
                    msg,
                    "invalid-code-id",
                    coins
                );
                await tx.wait();
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it("should fail to instantiate with an invalid init message", async () => {
            const msg = ethers.toUtf8Bytes(JSON.stringify({invalid: "message"}));
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            let error = null;
            try {
                const tx = await wasmdContract.instantiate(
                    codeId,
                    admin.seiAddress,
                    msg,
                    "invalid-init-msg",
                    coins
                );
                await tx.wait();
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it("should instantiate with a different admin address", async () => {
            const initMsg = {
                name: "AliceAdmin",
                symbol: "AAD",
                decimals: 6,
                initial_balances: [
                    {address: alice.seiAddress, amount: "100000"},
                ],
                mint: {minter: alice.seiAddress},
            };
            const msg = ethers.toUtf8Bytes(JSON.stringify(initMsg));
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            const tx = await wasmdContract.instantiate(
                codeId,
                alice.seiAddress,
                msg,
                "alice-admin-cw20",
                coins
            );
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);
        });
    });

    describe("Cross-function integration", function () {
        it("should instantiate a contract, execute a mint, and query the result", async () => {
            const initMsg = {
                name: "IntegrationToken",
                symbol: "INT",
                decimals: 6,
                initial_balances: [],
                mint: {minter: admin.seiAddress},
            };
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            const instantiateTx = await wasmdContract.instantiate(
                codeId,
                admin.seiAddress,
                ethers.toUtf8Bytes(JSON.stringify(initMsg)),
                "integration-test-cw20",
                coins
            );
            await instantiateTx.wait();
            await waitFor(1);

            const contracts = await admin.seiWallet.cosmWasmSigningClient.getContracts(codeId);
            const newAddr = contracts[contracts.length - 1];

            const mintMsg = {
                mint: {recipient: alice.seiAddress, amount: "777777"},
            };
            const mintTx = await wasmdContract.execute(
                newAddr,
                ethers.toUtf8Bytes(JSON.stringify(mintMsg)),
                coins
            );
            await mintTx.wait();
            await waitFor(1);

            const queryMsg = {balance: {address: alice.seiAddress}};
            const responseBytes = await wasmdContract.query(
                newAddr,
                ethers.toUtf8Bytes(JSON.stringify(queryMsg))
            );
            const response = JSON.parse(ethers.toUtf8String(responseBytes));

            expect(Number(response.balance)).to.eq(777777);
        });

        it("should execute via precompile and verify via cosmos query client", async () => {
            const transferAmount = "50000";
            const executeMsg = {
                transfer: {
                    recipient: bob.seiAddress,
                    amount: transferAmount,
                },
            };
            const msg = ethers.toUtf8Bytes(JSON.stringify(executeMsg));
            const coins = ethers.toUtf8Bytes(JSON.stringify([]));

            const tx = await wasmdContract.execute(cw20ContractAddress, msg, coins);
            await tx.wait();
            await waitFor(1);

            const cosmosBalance = await admin.seiWallet.cosmWasmSigningClient.queryContractSmart(
                cw20ContractAddress,
                {balance: {address: bob.seiAddress}}
            );

            const precompileQueryMsg = {balance: {address: bob.seiAddress}};
            const responseBytes = await wasmdContract.query(
                cw20ContractAddress,
                ethers.toUtf8Bytes(JSON.stringify(precompileQueryMsg))
            );
            const precompileBalance = JSON.parse(ethers.toUtf8String(responseBytes));

            expect(cosmosBalance.balance).to.eq(precompileBalance.balance);
        });
    });
});

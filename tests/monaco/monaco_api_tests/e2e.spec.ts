import { MonacoSDK } from "@0xmonaco/core";
import { Contract } from "ethers";
import { Erc20Token } from "../../../shared/Token";
import { SeiUser, UserFactory } from "../../../shared/User";
import { AccountsClient } from "./clients/AccountsClient";
import { AuthClient } from "./clients/AuthClient";
import { DepositClient } from "./clients/DepositClient";
import TradingClient from "./clients/TradingClient";
import VaultClient from "./clients/VaultClient";
import tenantConfig from '../config.json';
import { CONTRACT_ABIS } from "@0xmonaco/contracts";
import { expect } from "chai";
import { ethers } from "ethers";
import { approveAndMint } from "./utils/utils";

describe('Monaco E2E Tests', () => {
    const clientId = tenantConfig.yasinDex.clientId;
    const vaultAddress = tenantConfig.yasinDex.vaultAddress;
    const testPairs = ['USDCo/MTK', 'ETH/USDC'];
    let orderClient: TradingClient;
    let testUser: SeiUser;
    let monacoSdk: MonacoSDK;
    let vaultClient: VaultClient;
    let usdcContract: Erc20Token;
    let mtkContract: Erc20Token;
    let vaultContract: Contract;
    let authState: any;
    let depositClient: DepositClient;
    let accountClient: AccountsClient;
    let authClient: AuthClient;

    before('Initializes clients', async () => {
        let admin = await UserFactory.createAdminUser();
        testUser = await UserFactory.createSeiUser(admin, 'alice');
        await UserFactory.fundAddressOnSei(testUser.seiAddress, 'usei', '1000000');
        orderClient = new TradingClient(tenantConfig.baseUrl, clientId);
        authClient = new AuthClient(tenantConfig.baseUrl, clientId);

        usdcContract = new Erc20Token(testUser, tenantConfig.MOCK_USDC_ADDRESS);
        mtkContract = new Erc20Token(testUser, tenantConfig.MTK_ADDRESS);
        vaultClient = new VaultClient(tenantConfig.baseUrl, clientId);
        depositClient = new DepositClient(tenantConfig.baseUrl, clientId);
        vaultContract = new Contract(tenantConfig.yasinDex.vaultAddress, CONTRACT_ABIS.vault, testUser.evmWallet.wallet);
        accountClient = new AccountsClient(tenantConfig.baseUrl, clientId);
        //Login
        const challenge = await authClient.requestChallenge(testUser);
        const signedMessage = await testUser.evmWallet.wallet.signMessage(challenge.message);
        authState = await authClient.verifyChallenge(testUser, challenge, signedMessage);
    });

    it('User successfully logs in and sees information about their account', async () => {
        const accountData = await accountClient.queryAccountData(authState.access_token);
        expect(accountData.status).to.equal(200);
        const responseData = await accountData.json();
        // Adjust property access according to actual response structure
        // If accountData.data.id exists, use that; otherwise, adjust as needed
        expect(responseData.data?.id).to.not.be.undefined;
    });

    it('User mints tokens for usdc and mtk', async () => {
        const usdcDepositAmount = '500000000';
        await approveAndMint(usdcContract, testUser, tenantConfig.yasinDex.vaultAddress, usdcDepositAmount);
        const depositSeedInfo = await depositClient.requestDepositSignature(authState.access_token, usdcDepositAmount);
        const depositTxReceipt = await vaultClient
            .depositFundsIntoVault(vaultContract, depositSeedInfo, tenantConfig.MOCK_USDC_ADDRESS, usdcDepositAmount);
    });


    it('User places a limit order for usdc', async () => {
        const limitOrderTx = await orderClient.placeLimitOrder('USDCo/MTK', 'BUY', '100000000', '100000000', authState.access_token);
        expect(limitOrderTx.status).to.equal(200);
    });

    it('User can withdraw usdc from the vault', async () => {
        const withdrawSeedInfo = await withdrawClient.requestWithdrawSignature(authState.access_token, usdcDepositAmount);
        const withdrawTxReceipt = await vaultClient
            .withdrawFundsFromVault(vaultContract, withdrawSeedInfo, tenantConfig.MOCK_USDC_ADDRESS, usdcDepositAmount);
        expect(withdrawTxReceipt.status).to.equal(200);

    });



})

import tenantConfig from '../config.json';
import TradingClient from "./clients/TradingClient";
import {SeiUser, UserFactory} from "../../../shared/User";
import {MonacoSDK} from "@0xmonaco/core";
import VaultClient from "./clients/VaultClient";
import {Erc20Token} from "../../../shared/Token";
import {OrderSide} from "../types";
import {expect} from "chai";
import {approveAndMint} from "./utils/utils";
import {DepositClient} from "./clients/DepositClient";
import {waitFor} from "../../../shared/utils/helpers";
import {Contract} from "ethers";
import {CONTRACT_ABIS} from "@0xmonaco/contracts";
import {AccountsClient} from "./clients/AccountsClient";
import MarketClient from "./clients/MarketClient";
import {AuthClient} from "./clients/AuthClient";

describe('Monaco Api Order Tests', function (){
    const clientId = tenantConfig.yasinDex2.clientId;
    const vaultAddress = tenantConfig.yasinDex2.vaultAddress;
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
        vaultContract = new Contract(vaultAddress, CONTRACT_ABIS.vault, testUser.evmWallet.wallet);
        accountClient = new AccountsClient(tenantConfig.baseUrl, clientId);
        //Login
        const challenge = await authClient.requestChallenge(testUser);
        const signedMessage = await testUser.evmWallet.wallet.signMessage(challenge.message);
        authState = await authClient.verifyChallenge(testUser, challenge, signedMessage);
        console.log(authState);
    });

    const orderSides = ['BUY', 'SELL'];
    const orderTypes = ['LIMIT', 'MARKET'];
    orderSides.forEach(side => {
        orderTypes.forEach(type => {
            it(`Users cant create a ${type} order on ${side} with insufficient balance`, async () => {
                try{
                    if(type === 'LIMIT') {
                        const orderReturn = await orderClient.placeLimitOrder(testPairs[0], side as OrderSide, '5', '5', authState.access_token);
                    } else {
                        const orderReturn = await orderClient.placeMarketOrder(testPairs[0], side as OrderSide, '5', authState.access_token);
                    }
                } catch (e: any){
                    expect(e.message).to.contain('Order validation failed');
                    await waitFor(1);
                }
            });

            it(`Users cant place ${type} order with negative amount on ${side} with insufficient balance`, async () => {
                try{
                    if(type === 'LIMIT') {
                        const orderReturn = await orderClient.placeLimitOrder(testPairs[0], side as OrderSide, '5', '-500', authState.access_token);
                    } else {
                        const orderReturn = await orderClient.placeMarketOrder(testPairs[0], side as OrderSide, '-500', authState.access_token);
                    }
                } catch (e: any){
                    expect(e.message).to.contain('Invalid quantity');
                }
                await waitFor(1);
            });

            it(`Users cant place a ${type} order with invalid access token on ${side} with insufficient balance`, async () => {

            });

            it(`Users cant place a ${type} order with invalid amount on ${side} with insufficient balance`, async () => {

            });
        });
    })

    it.only('Users can deposit funds to the vaults', async () =>{
        const usdcDepositAmount = '500000000';
        await approveAndMint(usdcContract, testUser, vaultAddress, usdcDepositAmount);
        const depositSeedInfo = await depositClient.requestDepositSignature(authState.access_token, usdcDepositAmount);
        const depositTxReceipt = await vaultClient
            .depositFundsIntoVault(vaultContract, depositSeedInfo, tenantConfig.MOCK_USDC_ADDRESS, usdcDepositAmount);
        console.log(depositTxReceipt);
        await waitFor(50);
        const userDataRaw = await accountClient.queryAccountData(authState.access_token);
        const userData = await userDataRaw.json();
        console.log(userData);
        const tokenBalance = userData.balances
            .find(b => b.token.toLowerCase() === tenantConfig.MOCK_USDC_ADDRESS.toLowerCase());
        expect(tokenBalance.available_balance).to.eq(usdcDepositAmount);
    });

    for (const side of orderSides) {
        for (const type of orderTypes) {
            it.only('Given that users have sufficient funds, they can place a ' + type + ' order on ' + side, async () =>{
                if (type === 'LIMIT'){
                    const sentOrder = await orderClient.placeLimitOrder(testPairs[0], side as OrderSide, '1', '1', authState.access_token);
                    console.log(sentOrder);
                    //validate that the balance is locked
                } else {
                    const sentOrder = await orderClient.placeMarketOrder(testPairs[0], side as OrderSide, '1', authState.access_token);
                    console.log(sentOrder);
                    //validate that the balance is locked
                    //validate that the order can be queried
                }
            });

            it(`The placed order type ${type} on ${side} is reflected on the accounts endpoint`, async () => {
                //how to validate this?

            });

            it(`Users cant place a ${type} order with invalid trading id on ${side}`, async () => {
                try{
                    if(type === 'LIMIT') {
                        const orderReturn = await orderClient.placeLimitOrder('USDC-MILLI', side as OrderSide, '3', '1.5', authState.access_token);
                    } else {
                        const orderReturn = await orderClient.placeMarketOrder('USDC-MILLI', side as OrderSide, '2', authState.access_token, {}, '');
                    }
                } catch (e: any){
                    expect(e.message).to.contain('Bad request');
                    await waitFor(1);
                }
            });

            it(`Users cant place a ${type} order with empty trading id on ${side}`, async () => {
                try{
                    if(type === 'LIMIT') {
                        const orderReturn = await orderClient.placeLimitOrder('', side as OrderSide, '3', '1.5', authState.access_token);
                    } else {
                        const orderReturn = await orderClient.placeMarketOrder('', side as OrderSide, '2', authState.access_token);
                    }
                } catch (e: any){
                    expect(e.message).to.contain('Bad request');
                    await waitFor(1);
                }
            });

            it(`Users cant place a ${type} order with non existing trading id on ${side}`, async () => {
                try{
                    if(type === 'LIMIT') {
                        const orderReturn = await orderClient.placeLimitOrder('USDCo/BTC', side as OrderSide, '3', '1.5', authState.access_token);
                    } else {
                        const orderReturn = await orderClient.placeMarketOrder('USDCo/BTC', side as OrderSide, '2', authState.access_token, {}, '');
                    }
                } catch (e: any){
                    expect(e.message).to.contain('Bad request');
                    await waitFor(1);
                }
            });

            //@toDo add minimum and maximum amounts once they become available
            const quantities = ['-500', '5,12', '', '0', '-below min']
            for (const quantity of quantities) {
                it(`Users cant place ${type} order with invalid quantity on ${side} with sufficient balance`, async () => {
                    try{
                        if(type === 'LIMIT') {
                            const orderReturn = await orderClient.placeLimitOrder(testPairs[0], side as OrderSide, '1', quantity, authState.access_token);
                        } else {
                            const orderReturn = await orderClient.placeMarketOrder(testPairs[0], side as OrderSide, quantity, authState.access_token);
                        }
                    } catch (e: any){
                        expect(e.message).to.contain('Invalid quantity');
                        await waitFor(1);
                    }
                })
            }

            const invalidTokens = ['', '0x0000000000000000000000000000000000000000', 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjNlNDU2Ny1lODliLTEyZDMtYTQ1Ni00MjY2MTQxNzQwMDAiLCJhZGRyZXNzIjoiMHgwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3IiwiYXBwX2lkIjoiOGE3NDM1M2YtNDU4NC00N2M5LWI3NTAtZDExYTVlM2RlZGIxIiwiY2xpZW50X3R5cGUiOiJmcm9udGVuZCIsImV4cCI6MTc2MTIyMzAxOSwiaWF0IjoxNzU4NjMxMDE5LCJqdGkiOiIwM2E3ODEzZi01Mzk2LTRiZmUtODhmYS1lMThjMGI4ZjUxMDAiLCJhY2NvdW50X3R5cGUiOiJtYXN0ZXIiLCJtYXN0ZXJfYWNjb3VudF9pZCI6bnVsbCwiY2FuX3dpdGhkcmF3Ijp0cnVlfQ.3cI9j0D-LydutP_CpjDjr6lSzWamNdhtJ2j3XtknCbw\n'];
            for (const invalidToken of invalidTokens) {
                it(`Users cant place a ${type} order with invalid access token on ${side}`, async () => {
                    try{
                        await waitFor(1);
                        if(type === 'LIMIT') {
                            const orderReturn = await orderClient.placeLimitOrder(testPairs[0], side as OrderSide, '5', '1', invalidToken);
                        } else {
                            const orderReturn = await orderClient.placeMarketOrder(testPairs[0], side as OrderSide, '1', invalidToken);
                        }
                    } catch (e: any){
                        expect(e.message).to.contain('Unauthorized');
                    }
                })
            }

            //@ToDo add ticks for invalid prices 
            const invalidPrices = ['', '0', '-500', '5,12', 'price']
            for (const invalidPrice of invalidPrices) {
                it(`Users cant place a ${type} order with invalid price on ${side}`, async () => {
                    try{
                        if(type === 'LIMIT') {
                            const orderReturn = await orderClient.placeLimitOrder(testPairs[0], side as OrderSide, invalidPrice, '1', authState.access_token);
                        } else {
                            const orderReturn = await orderClient.placeMarketOrder(testPairs[0], side as OrderSide, '1', authState.access_token, {}, invalidPrice);
                        }
                    } catch (e: any){
                        expect(e.message).to.contain('Bad request: Validation error');
                        await waitFor(1);
                    }
                })
            }
        }
    }

    let orders: any = {}
    it('Users query the data for min and max amounts', async () =>{
        const marketClient = new MarketClient(tenantConfig.baseUrl, clientId);
        const tradingPairInfo = await marketClient.getTradingPairInfo(testPairs[0], authState.access_token);
        console.log(tradingPairInfo);
        orders['minAmount'] = (Number(tradingPairInfo.responseData.data.min_order_size) - 0.0001).toString();
        orders['maxAmount'] = (Number(tradingPairInfo.responseData.data.max_order_size) + 0.1).toString();
    });

    const minMaxOrders = ['minAmount', 'maxAmount'];

    for (const order of minMaxOrders) {
        for (const side of orderSides) {
            for (const type of orderTypes) {
                it(`Users cant place a ${type} order that is not within ${order} on ${side} side`, async () =>{
                    await waitFor(1);
                    try {
                        if (type === 'LIMIT'){
                            const sentOrder = await orderClient.placeLimitOrder(testPairs[0], side as OrderSide, '1', orders[order], authState.access_token);
                        } else {
                            const sentOrder = await orderClient.placeMarketOrder(testPairs[0], side as OrderSide, orders[order], authState.access_token);
                        }
                    } catch (e: any) {
                        console.log(e.message);
                        await waitFor(2);
                    }
                });
            }
        }
    }
})

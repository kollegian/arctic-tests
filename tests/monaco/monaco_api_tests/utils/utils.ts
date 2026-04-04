import {SeiUser, UserFactory} from "../../../../shared/User";
import {Erc20Token} from "../../../../shared/Token";
import {Interface, Wallet} from "ethers";
import TradingClient from "../clients/TradingClient";
import tenantConfig from "../../config.json";
import {AuthClient} from "../clients/AuthClient";
import VaultClient from "../clients/VaultClient";
import {DepositClient} from "../clients/DepositClient";
import {Contract} from "ethers";
import {CONTRACT_ABIS} from "@0xmonaco/contracts";
import {AccountsClient} from "../clients/AccountsClient";
import MarketClient from "../clients/MarketClient";
import {UserBalance} from "../../types";
import {waitFor} from "../../../../shared/utils/helpers";

export interface MonacoClients {
    authClient: AuthClient;
    orderClient: TradingClient;
    vaultClient: VaultClient;
    depositClient: DepositClient;
    accountClient: AccountsClient;
    marketClient: MarketClient;
}

export interface MonacoContracts {
    usdcContract: Erc20Token;
    mtkContract: Erc20Token;
    vaultContract: Contract;
}

export interface MonacoSdkSetup {
    clients: MonacoClients;
    authState: Awaited<ReturnType<AuthClient['verifyChallenge']>>;
    contracts: MonacoContracts;
}

export async function approveAndMint(contract: Erc20Token, testUser: SeiUser, vaultAddress: string, depositAmount: string){
    const mintTx = await contract.mint(testUser.evmAddress, depositAmount);
    await mintTx.wait();

    const approvalTx = await contract.contract.connect(testUser.evmWallet.wallet).approve(vaultAddress, depositAmount);
    await approvalTx.wait();
}

export async function approveAndMintForEvm(contract: Erc20Token, testUser: Wallet, vaultAddress: string, depositAmount: string){
    const mintTx = await contract.mint(testUser.address, depositAmount);
    await mintTx.wait();

    const approvalTx = await contract.contract.connect(testUser).approve(vaultAddress, depositAmount);
    await approvalTx.wait();
}

export function decodeRevert(revertData: unknown, abi: any[]): string | undefined {
    try {
        if (!revertData) return undefined;
        const dataHex = typeof revertData === 'string' ? revertData : (revertData as any).data;
        if (typeof dataHex !== 'string' || !dataHex.startsWith('0x')) return undefined;
        const iface = new Interface(abi as any);
        const parsed = iface.parseError(dataHex);
        if (!parsed) return undefined;
        const args = parsed.args?.map((a: any) => (typeof a === 'bigint' ? a.toString() : a));
        return `${parsed.name}(${args?.join(', ') ?? ''})`;
    } catch (_) {
        return undefined;
    }
}

export async function createContracts(testUser: SeiUser){
    const usdcContract = new Erc20Token(testUser, tenantConfig.MOCK_USDC_ADDRESS);
    const mtkContract = new Erc20Token(testUser, tenantConfig.MTK_ADDRESS);
    return {usdcContract, mtkContract};
}

export async function createClientAndLoginToTheSdk(clientId: string, vaultAddress: string, testUser: SeiUser): Promise<MonacoSdkSetup> {

    const orderClient = new TradingClient(tenantConfig.baseUrl, clientId);
    const authClient = new AuthClient(tenantConfig.baseUrl, clientId);

    const contracts = await createContracts(testUser);
    const vaultClient = new VaultClient(tenantConfig.baseUrl, clientId);
    const depositClient = new DepositClient(tenantConfig.baseUrl, clientId);
    const vaultContract = new Contract(vaultAddress, CONTRACT_ABIS.vault, testUser.evmWallet.wallet);
    const accountClient = new AccountsClient(tenantConfig.baseUrl, clientId);
    const marketClient = new MarketClient(tenantConfig.baseUrl, clientId);
    //Login
    const authState = await loginToTheSdk(testUser, authClient);
    console.log(authState);
    return {
        clients: {authClient, orderClient, vaultClient, depositClient, accountClient, marketClient},
        authState,
        contracts: {...contracts, vaultContract}
    }
}

export async function loginToTheSdk(testUser: SeiUser, authClient: AuthClient) {
    const challenge = await authClient.requestChallenge(testUser);
    const signedMessage = await testUser.evmWallet.wallet.signMessage(challenge.message);
    return await authClient.verifyChallenge(testUser, challenge, signedMessage);
}

export async function fundUserWithToken(
    contract: Erc20Token,
    vaultContract: Contract,
    testUser: SeiUser,
    vaultAddress: string,
    depositAmount: string,
    tokenAddress: string,
    clients: MonacoClients,
    authState: any
): Promise<void> {
    await approveAndMint(contract, testUser, vaultAddress, depositAmount);
    console.log('Token minted');
    const depositSeedInfo = await clients.depositClient.requestDepositSignature(authState.access_token, '50000');
    await waitFor(1);
    const receipt = await clients.vaultClient.depositFundsIntoVault(vaultContract, depositSeedInfo, tokenAddress, '50000');
    await new Promise(resolve => setTimeout(resolve, 3000));
    console.log('User funded');
    await waitFor(1);
}

export async function fundUserWithUSDC(
    contracts: MonacoContracts,
    testUser: SeiUser,
    vaultAddress: string,
    clients: MonacoClients,
    authState: any,
    depositAmount: string = '100000000'
): Promise<void> {
    await fundUserWithToken(
        contracts.usdcContract,
        contracts.vaultContract,
        testUser,
        vaultAddress,
        depositAmount,
        tenantConfig.MOCK_USDC_ADDRESS,
        clients,
        authState
    );
}

export async function fundUserWithMTK(
    contracts: MonacoContracts,
    testUser: SeiUser,
    vaultAddress: string,
    clients: MonacoClients,
    authState: any,
    depositAmount: string = '1000000000000000000000' // 1000 MTK in wei
): Promise<void> {
    await fundUserWithToken(
        contracts.mtkContract,
        contracts.vaultContract,
        testUser,
        vaultAddress,
        depositAmount,
        tenantConfig.MTK_ADDRESS,
        clients,
        authState
    );
}

export async function queryBalance(monacoSdkSetup: MonacoSdkSetup, token: string): Promise<UserBalance> {
    const userState = await monacoSdkSetup.clients.accountClient.queryAccountData(monacoSdkSetup.authState.access_token);
    return userState.data.balances.find((b: any) => b.token.toLowerCase() === token.toLowerCase())!;
}

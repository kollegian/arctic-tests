import {BaseApiClient} from "./BaseApiClient";
import {ethers} from "ethers/lib.esm";
import {waitFor} from "../../../../shared/utils/helpers";
import {SeiUser} from "../../../../shared/User";

export default class VaultClient extends BaseApiClient {
    constructor(url: string, clientId: string) {
        super(url, clientId);
    }

    async queryVaultAddress(accessToken: string){
        const url = `${this.url}/api/v1/applications/config`;
        const options = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
        }
        const response = await fetch(url, options);
        const data = await response.json();
        return data.vault_contract_address;
    }

    async depositFundsIntoVault(vaultContract: ethers.Contract, depositSeedInfo: any, tokenContractAddress: string, amount: string, signer?: SeiUser){
        if (signer) {
            const depositTx = await vaultContract
                .connect(signer.evmWallet.wallet).deposit(tokenContractAddress, amount, depositSeedInfo.seed, depositSeedInfo.signature);
            return await depositTx.wait();
        }
        const depositTx = await vaultContract
            .deposit(tokenContractAddress, amount, depositSeedInfo.seed, depositSeedInfo.signature);
        return await depositTx.wait();
    }

    async withdrawFundsFromVault(vaultContract: ethers.Contract, withdrawSeedInfo: any, tokenContractAddress: string, amount: string){
        const withdrawTx = await vaultContract
            .withdraw(tokenContractAddress, amount, withdrawSeedInfo.seed, withdrawSeedInfo.signature);
        return await withdrawTx.wait();
    }
}

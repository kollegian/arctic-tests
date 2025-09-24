import {BaseApiClient} from "./BaseApiClient";
import {vault} from "googleapis/build/src/apis/vault";
import {CONTRACT_ABIS} from "@0xmonaco/contracts";

export class DepositClient extends BaseApiClient {
    constructor(url: string, clientId: string) {
        super(url, clientId);
    }

    async requestDepositSignature(accessToken: string, amount: string){
        const request = {
            amount,
            expiry: undefined,
        };

        const response = await fetch(`${this.url}/api/v1/deposit/signature`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify(request),
        });
        return await response.json();
    }

    async requestWithdrawalSignature(accessToken: string, amount: string, vaultAddress: string, tokenAddress: string, userAddress: string){
        const request = {
            vault_contract_address: vaultAddress,
            chain_id: 1328,
            amount,
        };
        const response = await fetch(`${this.url}/api/v1/withdraw/signature`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify(request),
        });
        return await response.json();
    }
}

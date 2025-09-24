import {SeiUser} from "../../../../shared/User";
import {BaseApiClient} from "./BaseApiClient";

export class AuthClient extends BaseApiClient{

    constructor(url:string, clientId:string) {
        super(url, clientId);
    }

    async requestChallenge(testUser: SeiUser){
        const url = `${this.url}/api/v1/auth/challenge`;
        const options = {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: `{"address":"${testUser.evmAddress}","client_id":"${this.clientId}"}`
        };

        const response = await fetch(url, options);
        return await response.json();
    };

    async verifyChallenge(testUser: SeiUser, challengeResponse: any, signedMessage: string){
        const url = `${this.url}/api/v1/auth/verify`;
        const options = {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: `{"address":"${testUser.evmAddress}","client_id":"${this.clientId}","nonce":"${challengeResponse.nonce}","signature":"${signedMessage}"}`
        };

        const response = await fetch(url, options);
        return await response.json();
    }

    async authenticateBackend(secretKey: string){
        const url = 'https://dev.api-monaco.xyz/api/v1/auth/backend';
        const options = {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: `{"secret_key":"${secretKey}"}`
        };

        const response = await fetch(url, options);
        return await response.json();
    }

    async verifyBackendChallenge(secretKey: string, challengeResponse: any, signedMessage: string){
        const url = `${this.url}/backend/verify`;
        const options = {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: `{"client_secret":"${secretKey}","nonce":"${challengeResponse.nonce}","signature":"${signedMessage}"}`
        };

        const response = await fetch(url, options);
        return await response.json();
    }
}

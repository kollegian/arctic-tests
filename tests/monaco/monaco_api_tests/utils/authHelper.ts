import { createWalletClient, http, publicActions, WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export interface AuthResult {
    name: string;
    clientId: string;
    accessToken: string;
    refreshToken: string;
    user: any;
    expiresAt: string;
}

export interface ClientConfig {
    name: string;
    id: string;
}

export async function authenticateWithClient(
    apiBaseUrl: string,
    clientId: string,
    clientName: string,
    account: any,
    walletClient: any
): Promise<AuthResult | null> {
    try {
        // Step 1: Request challenge
        console.log(`\n📝 Requesting challenge for ${clientName}...`);
        const challengeResponse = await fetch(`${apiBaseUrl}/api/v1/auth/challenge`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                address: account.address,
                client_id: clientId,
            }),
        });

        if (!challengeResponse.ok) {
            const error = await challengeResponse.text();
            throw new Error(`Challenge failed: ${error}`);
        }

        const challenge = await challengeResponse.json();

        // Step 2: Sign the message
        const signature = await walletClient.signMessage({
            account: walletClient.account!,
            message: challenge.message,
        });

        // Step 3: Verify signature
        const verifyResponse = await fetch(`${apiBaseUrl}/api/v1/auth/verify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                address: account.address,
                signature: signature,
                nonce: challenge.nonce,
                client_id: clientId,
            }),
        });

        if (!verifyResponse.ok) {
            const error = await verifyResponse.text();
            throw new Error(`Verification failed: ${error}`);
        }

        const authData = await verifyResponse.json();
        console.log(`✅ ${clientName} authenticated successfully!`);

        return {
            name: clientName,
            clientId: clientId,
            accessToken: authData.access_token,
            refreshToken: authData.refresh_token,
            user: authData.user,
            expiresAt: new Date(authData.expires_at * 1000).toISOString(),
        };
    } catch (error) {
        console.error(`❌ Failed to authenticate ${clientName}:`, error);
        return null;
    }
}

export async function authenticateAllClients(
    apiBaseUrl: string,
    clientIds: ClientConfig[],
    privateKey: string
): Promise<Map<string, AuthResult>> {
    // Create account and wallet client
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({
        account,
        transport: http('https://evm-rpc-testnet.sei-apis.com'),
    }).extend(publicActions);

    console.log('='.repeat(80));
    console.log('🔐 Multi-Application Authentication');
    console.log('='.repeat(80));
    console.log(`Wallet address: ${account.address}`);
    console.log(`API URL: ${apiBaseUrl}`);
    console.log(`Authenticating with ${clientIds.length} applications`);
    console.log('='.repeat(80));

    const results = new Map<string, AuthResult>();

    // Authenticate with each client
    for (const client of clientIds) {
        const result = await authenticateWithClient(apiBaseUrl, client.id, client.name, account, walletClient);
        if (result) {
            results.set(client.name, result);
        }
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`\n✅ Successfully authenticated: ${results.size}/${clientIds.length}`);

    return results;
}

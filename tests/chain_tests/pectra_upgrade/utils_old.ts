import {SeiUser} from "../../../shared/User";
import {ethers} from "ethers";
import {AtomicTxSender} from "../../../shared/TxBuilder";
import {createWalletClient, http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';

export async function createAuthorization({
                                              fromUser,
                                              contractAddress,
                                              nonce,
                                              chainId
                                          }: {
    fromUser: SeiUser,
    contractAddress: string,
    nonce: number,
    chainId: bigint
}) {
    console.log('Creating authorization with:', {
        chainId: chainId.toString(),
        contractAddress,
        nonce,
        fromAddress: fromUser.evmAddress
    });

    try {
        // Get the private key from the user's wallet
        const privateKey = fromUser.evmWallet.wallet.privateKey;
        console.log('Private key:', privateKey);

        // Create viem account and wallet client
        const account = privateKeyToAccount(privateKey as `0x${string}`);
        console.log('Viem account:', account.address);

        const walletClient = createWalletClient({
            account,
            transport: http('http://3.135.204.134:8545'),
        });

        console.log('Attempting viem signAuthorization...');
        // Use viem's signAuthorization method as shown in the EIP-7702 examples
        const authorization = await walletClient.signAuthorization({
            contractAddress: contractAddress as `0x${string}`,
            executor: "self",
        });

        console.log('Viem authorization:', authorization);

        return authorization;
    } catch (error) {
        console.error('Error creating authorization with viem:', error);
        console.error('Error details:', error.message);

        // Fallback to manual signature creation
        console.log('Falling back to manual signature creation...');
        console.log('Fallback parameters:', {
            chainId: chainId.toString(),
            chainIdHex: '0x' + chainId.toString(16),
            contractAddress,
            nonce
        });

        // Create authorization message according to EIP-7702
        // The message should be exactly 32 bytes: keccak256(chainId || contractAddress || nonce)
        const authMessage = ethers.solidityPacked(
            ['uint256', 'address', 'uint256'],
            [chainId, contractAddress, nonce]
        );

        console.log('Auth message (hex):', ethers.hexlify(authMessage));
        console.log('Auth message length:', authMessage.length);

        // Hash the message to get a 32-byte digest
        const messageHash = ethers.keccak256(authMessage);
        console.log('Message hash:', messageHash);
        console.log('Message hash length:', messageHash.length);

        // Use the wallet's signing key to sign the hash
        const signature = fromUser.evmWallet.wallet.signingKey.sign(messageHash);
        console.log('Signature:', signature);

        console.log('Parsed signature:', {
            v: signature.v,
            r: signature.r,
            s: signature.s
        });

        const result = {
            chain_id: chainId,
            address: contractAddress,
            nonce: nonce,
            y_parity: signature.v,
            r: signature.r,
            s: signature.s
        };

        console.log('Final authorization result:', result);
        return result;

    }
}

export async function sendType4Tx({
                                      fromUser,
                                      to,
                                      data,
                                      value = 0n,
                                      gasLimit = 1000000n,
                                      maxFeePerGas,
                                      maxPriorityFeePerGas,
                                      nonce,
                                      chainId,
                                      authorizationList = []
                                  }: {
    fromUser: SeiUser,
    to: string,
    data: string,
    value?: bigint,
    gasLimit?: bigint,
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint,
    nonce: number,
    chainId: bigint,
    authorizationList?: any[]
}) {
    const txRequest = {
        to,
        data,
        value,
        gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        nonce,
        chainId,
        type: 4,
        authorizationList
    } as any;

    const signedTx = await fromUser.evmWallet.wallet.signTransaction(txRequest);
    const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
        fromUser.evmWallet.signingClient,
        signedTx
    );
    return fromUser.evmWallet.signingClient.waitForTransaction(txHash);
}

// New function following EIP-7702 examples for batch execution
export async function executeBatchWithViem({
                                               fromUser,
                                               contractAddress,
                                               calls
                                           }: {
    fromUser: SeiUser,
    contractAddress: string,
    calls: Array<{ target: string, value: bigint, data: string }>
}) {
    try {
        // Get the private key from the user's wallet
        const privateKey = fromUser.evmWallet.wallet.privateKey;

        // Create viem account and wallet client
        const account = privateKeyToAccount(privateKey as `0x${string}`);
        const walletClient = createWalletClient({
            account,
            transport: http('http://3.135.204.134:8545'),
        });

        // Create authorization
        const authorization = await walletClient.signAuthorization({
            contractAddress: contractAddress as `0x${string}`,
            executor: "self",
        });

        console.log('Authorization created:', authorization);

        // First, send the authorization transaction
        const authHash = await walletClient.sendTransaction({
            authorizationList: [authorization],
            data: "0x",
            to: fromUser.evmAddress as `0x${string}`,
        });

        console.log(`Authorization sent at tx ${authHash}`);

        // Wait for the authorization to be processed
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Now execute the batch using writeContract
        const batchHash = await walletClient.writeContract({
            abi: [{
                "inputs": [{
                    "components": [{
                        "internalType": "address",
                        "name": "target",
                        "type": "address"
                    }, {"internalType": "uint256", "name": "value", "type": "uint256"}, {
                        "internalType": "bytes",
                        "name": "data",
                        "type": "bytes"
                    }], "internalType": "struct BaseAccount.Call[]", "name": "calls", "type": "tuple[]"
                }],
                "name": "executeBatch",
                "outputs": [],
                "stateMutability": "nonpayable",
                "type": "function"
            }],
            address: fromUser.evmAddress as `0x${string}`,
            functionName: "executeBatch",
            args: [calls],
        });

        console.log(`Batch executed at tx ${batchHash}`);
        return batchHash;

    } catch (error) {
        console.error('Error executing batch with viem:', error);
        throw error;
    }
}

async function signAuthorization(
    signer: ethers.Signer,
    contractAddress: string,
    chainId: number,
    executor: string = "self"
) {
    // EIP-712 domain
    const domain = {
        name: "Authorization",
        version: "1",
        chainId,
        verifyingContract: contractAddress,
    };

    // EIP-712 types
    const types = {
        Authorization: [
            { name: "executor", type: "address" },
            { name: "contractAddress", type: "address" },
            // add nonce/deadline if you want stricter replay protection
        ],
    };

    // Message
    const value = {
        executor: executor === "self" ? await signer.getAddress() : executor,
        contractAddress,
    };

    // Sign typed data
    const signature = await (signer as ethers.providers.JsonRpcSigner)._signTypedData(
        domain,
        types,
        value
    );

    return {
        domain,
        types,
        value,
        signature,
    };
}

import { createPublicClient, createWalletClient, http, parseAbi, Hex, Address } from 'viem';
import { CONTRACT_ABIS } from '@0xmonaco/contracts';
import { privateKeyToAccount } from 'viem/accounts';

const RPC_URL = 'http://18.159.252.65:8545';
const SEI_EVM_TESTNET = {
  id: 1328,
  name: 'Sei EVM Testnet',
  nativeCurrency: { name: 'SEI', symbol: 'SEI', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;
const API_BASE_URL = 'https://dev.api-monaco.xyz';
const CLIENT_ID = 'd551b47f8848497e908ad8f0df60966b';
const VAULT_ADDRESS: Address = '0x7921ddd1F1cC6D4526B705cE5DAED8d548d57188';
const USDC_ADDRESS: Address = '0x6A86dA986797D59A839D136dB490292Cd560C131';
const PRIVATE_KEY = '0xaad24d317b40cf3a30672456ea20d0e911885f5ba5deb945e5d9df6f944fd135';

// Use vault ABI from the package; define minimal ERC20 ABI locally
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)'
]);
const VAULT_ABI = CONTRACT_ABIS.vault;

type ChallengeResponse = { nonce: string; message: string; expires_at: number };
type VerifyResponse = { access_token: string; refresh_token?: string };
type DepositSignatureResponse = { success: boolean; data: { seed: Hex; signature: Hex } };

async function mintErc20(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  token: Address,
  to: Address,
  amount: bigint,
  from: Address,
) {
  const txHash = await walletClient.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'mint',
    args: [to, amount],
    // rely on walletClient's LocalAccount to sign & send raw tx
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

async function ensureApprove(
  walletClient: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  token: Address,
  owner: Address,
  spender: Address,
  minAmount: bigint,
) {
  const allowance = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  }) as bigint;
  if (allowance >= minAmount) return null;
  const txHash = await walletClient.writeContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, minAmount],
    // rely on walletClient's LocalAccount to sign & send raw tx
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

async function main() {
  const privKey = PRIVATE_KEY;
  if (!privKey) {
    console.error('Usage: tsx src/order-poc.ts <PRIVATE_KEY> [DEPOSIT_AMOUNT]');
    process.exit(1);
  }
  const depositAmountArg = '100000000000';

  const account = privateKeyToAccount(`0x${privKey.replace(/^0x/, '')}`);
  const publicClient = createPublicClient({ chain: SEI_EVM_TESTNET, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: SEI_EVM_TESTNET, transport: http(RPC_URL) });

  console.log(`Using EVM address: ${account.address}`);

  console.log('Requesting auth challenge...');
  const challengeRes = await fetch(`${API_BASE_URL}/api/v1/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: account.address, client_id: CLIENT_ID }),
  });
  if (!challengeRes.ok) {
    const text = await challengeRes.text();
    throw new Error(`Challenge failed: ${challengeRes.status} ${text}`);
  }
  const challenge = (await challengeRes.json()) as ChallengeResponse;

  const signature = await walletClient.signMessage({ account, message: challenge.message });

  console.log('Verifying signature...');
  const verifyRes = await fetch(`${API_BASE_URL}/api/v1/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: account.address,
      signature,
      nonce: challenge.nonce,
      client_id: CLIENT_ID,
    }),
  });
  if (!verifyRes.ok) {
    const text = await verifyRes.text();
    throw new Error(`Verify failed: ${verifyRes.status} ${text}`);
  }
  const verify = (await verifyRes.json()) as VerifyResponse;
  const accessToken = verify.access_token;
  console.log('Authenticated.');

  // 2) Mint tokens on USDC contract (regular ERC20 mint)
  console.log('Minting mock USDC...');
  const mintHash = await mintErc20(walletClient, publicClient, USDC_ADDRESS, account.address, BigInt(depositAmountArg), account.address);
  console.log('Minted.');

  // 3) Approve vault if needed
  const required = BigInt(depositAmountArg);
  const approveHash = await ensureApprove(walletClient, publicClient, USDC_ADDRESS, account.address, VAULT_ADDRESS, required);
  if (approveHash) console.log('Approved vault.'); else console.log('Sufficient allowance exists.');

  // 4) Request deposit signature via API
  console.log('Requesting deposit signature...');
  const depSigRes = await fetch(`${API_BASE_URL}/api/v1/deposit/signature`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ amount: depositAmountArg }),
  });
  if (!depSigRes.ok) {
    const text = await depSigRes.text();
    throw new Error(`Deposit signature failed: ${depSigRes.status} ${text}`);
  }
  const depSig = (await depSigRes.json()) as any;
  const seed = depSig.seed as Hex;
  const sig = depSig.signature as Hex;

  // 5) Deposit to the vault via contract call
  console.log('Depositing to vault...');
  const depositHash = await walletClient.writeContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: 'deposit',
    args: [USDC_ADDRESS, required, seed, sig],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
  console.log(`Deposit tx status: ${receipt.status}`);
  console.log('Deposit TX Hash on atlantic 2 is ', receipt.transactionHash);

  const orderBody = {
    trading_pair: 'USDCo/MTK',
    order_type: 'LIMIT',
    side: 'SELL',
    price: '1',
    quantity: '1',
    trading_mode: 'SPOT',
    use_master_balance: false,
  } as const;
  console.log('Creating order...');
  const orderRes = await fetch(`${API_BASE_URL}/api/v1/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(orderBody),
  });
  const orderText = await orderRes.text();
  if (!orderRes.ok) {
    throw new Error(`Order creation failed: ${orderRes.status} ${orderText}`);
  }
  console.log(`Order response: ${orderText}`);
}

main().catch((err) => {
    console.log('Starting');
  console.error(err);
  process.exit(1);
});



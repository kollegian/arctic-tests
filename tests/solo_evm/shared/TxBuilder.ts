import { ethers, Contract, ContractFactory, TransactionResponse, TransactionReceipt, BaseContract, TransactionRequest, AccessList } from 'ethers';
import { User } from './User';
import { BatchTxResult, BlockFillResult, FillBlocksResult } from './types';

import ERC20_ARTIFACT from '../../../artifacts/contracts/TestERC20.sol/TestERC20.json';
import GAS_BURNER_ARTIFACT from '../../../artifacts/contracts/GasBurner.sol/RealGasBurner.json';
import SIMPLE_ACCOUNT_7702_ARTIFACT from '../../../artifacts/contracts/SimpleAccount7702.sol/SimpleAccount7702.json';

interface TxOverrides {
  nonce?: number;
  gasLimit?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

interface ERC20Contract extends BaseContract {
  mint(to: string, amount: bigint, overrides?: TxOverrides): Promise<TransactionResponse>;
  transfer(to: string, amount: bigint, overrides?: TxOverrides): Promise<TransactionResponse>;
  balanceOf(address: string): Promise<bigint>;
  approve(spender: string, amount: bigint, overrides?: TxOverrides): Promise<TransactionResponse>;
  allowance(owner: string, spender: string): Promise<bigint>;
}

interface GasBurnerContract extends BaseContract {
  burnGas(salt: bigint, overrides?: TxOverrides): Promise<TransactionResponse>;
  burnGasOverMaxLimit(salt: bigint, overrides?: TxOverrides): Promise<TransactionResponse>;
  burnGasIterations(salt: bigint, iterations: bigint, overrides?: TxOverrides): Promise<TransactionResponse>;
}

const SEI_GAS_PER_ITERATION = 75300n;

export class TxBuilder {
  private users: User[];
  private erc20Contract: Contract | null = null;
  private gasBurnerContract: Contract | null = null;
  private simpleAccount7702Contract: Contract | null = null;

  constructor(users: User[]) {
    this.users = users;
  }

  getUsers(): User[] {
    return this.users;
  }

  getUser(index: number): User {
    return this.users[index];
  }

  setErc20(address: string): void {
    if (this.users.length === 0) throw new Error('No users available');
    this.erc20Contract = new Contract(address, ERC20_ARTIFACT.abi, this.users[0].wallet);
  }

  getErc20(): Contract {
    if (!this.erc20Contract) throw new Error('ERC20 not set. Call setErc20() or deployErc20() first');
    return this.erc20Contract;
  }

  setGasBurner(address: string): void {
    if (this.users.length === 0) throw new Error('No users available');
    this.gasBurnerContract = new Contract(address, GAS_BURNER_ARTIFACT.abi, this.users[0].wallet);
  }

  getGasBurner(): Contract {
    if (!this.gasBurnerContract) throw new Error('GasBurner not set. Call setGasBurner() or deployGasBurner() first');
    return this.gasBurnerContract;
  }

  setSimpleAccount7702(address: string): void {
    if (this.users.length === 0) throw new Error('No users available');
    this.simpleAccount7702Contract = new Contract(address, SIMPLE_ACCOUNT_7702_ARTIFACT.abi, this.users[0].wallet);
  }

  getSimpleAccount7702(): Contract {
    if (!this.simpleAccount7702Contract) throw new Error('SimpleAccount7702 not set. Call setSimpleAccount7702() or deploySimpleAccount7702() first');
    return this.simpleAccount7702Contract;
  }

  getSimpleAccount7702Address(): string {
    return this.getSimpleAccount7702().target as string;
  }

  async deployContract(
    deployer: User,
    abi: any[],
    bytecode: string,
    constructorArgs: any[] = []
  ): Promise<Contract> {
    const factory = new ContractFactory(abi, bytecode, deployer.wallet);
    const contract = await factory.deploy(...constructorArgs);
    await contract.waitForDeployment();
    return contract as Contract;
  }

  async deployErc20(deployer: User): Promise<Contract> {
    const contract = await this.deployContract(
      deployer,
      ERC20_ARTIFACT.abi,
      ERC20_ARTIFACT.bytecode,
      [deployer.address]
    );
    this.erc20Contract = contract;
    return contract;
  }

  async deployGasBurner(deployer: User): Promise<Contract> {
    const contract = await this.deployContract(
      deployer,
      GAS_BURNER_ARTIFACT.abi,
      GAS_BURNER_ARTIFACT.bytecode,
      []
    );
    this.gasBurnerContract = contract;
    return contract;
  }

  async deploySimpleAccount7702(deployer: User): Promise<Contract> {
    const contract = await this.deployContract(
      deployer,
      SIMPLE_ACCOUNT_7702_ARTIFACT.abi,
      SIMPLE_ACCOUNT_7702_ARTIFACT.bytecode,
      []
    );
    this.simpleAccount7702Contract = contract;
    return contract;
  }

  async mintToUsers(amount = ethers.parseEther('1000')): Promise<BatchTxResult> {
    const contract = this.getErc20();
    
    
    return this.sendParallelTxs(
      this.users,
      (user) => (contract.connect(user.wallet) as unknown as ERC20Contract).mint(
        user.address, 
        amount, 
        { gasLimit: 2000000n }
      )
    );
  }

  async mintToUser(user: User, amount = ethers.parseEther('1000')): Promise<TransactionReceipt | null> {
    const contract = this.getErc20();
    const tx = await (contract.connect(user.wallet) as unknown as ERC20Contract).mint(user.address, amount);
    return tx.wait();
  }


  async erc20TransfersToAddress(
    to: string,
    amount = ethers.parseEther('1')
  ): Promise<BatchTxResult> {
    const contract = this.getErc20();
    return this.sendParallelTxs(
      this.users,
      (user) => (contract.connect(user.wallet) as unknown as ERC20Contract).transfer(
        to, 
        amount,
        { gasLimit: 100000n }
      )
    );
  }

  async erc20TransfersRoundRobin(amount = ethers.parseEther('1')): Promise<BatchTxResult> {
    const contract = this.getErc20();
    return this.sendParallelTxs(
      this.users,
      (user, index) => {
        const nextIndex = (index + 1) % this.users.length;
        return (contract.connect(user.wallet) as unknown as ERC20Contract).transfer(
          this.users[nextIndex].address, 
          amount,
          { gasLimit: 100000n }
        );
      }
    );
  }


  async nativeTransfersToAddress(
    to: string,
    amount = ethers.parseEther('0.01')
  ): Promise<BatchTxResult> {
    return this.sendParallelTxs(
      this.users,
      (user) => user.wallet.sendTransaction({ to, value: amount })
    );
  }

  async nativeTransfersRoundRobin(amount = ethers.parseEther('0.01')): Promise<BatchTxResult> {
    return this.sendParallelTxs(
      this.users,
      (user, index) => {
        const nextIndex = (index + 1) % this.users.length;
        return user.wallet.sendTransaction({ 
          to: this.users[nextIndex].address, 
          value: amount 
        });
      }
    );
  }

  async sendParallelTxs(
    users: User[],
    txFn: (user: User, index: number) => Promise<TransactionResponse>
  ): Promise<BatchTxResult> {
    const txPromises = users.map((user, index) => txFn(user, index));
    const txResponses = await Promise.all(txPromises);
    
    const receiptPromises = txResponses.map(tx => 
      tx.wait().catch((e: any) => {
        if (e.receipt) return e.receipt;
        return null;
      })
    );
    const receipts = await Promise.all(receiptPromises);

    const validReceipts = receipts.filter((r): r is TransactionReceipt => r !== null);
    const blockNumbers = validReceipts.map(r => r.blockNumber);
    
    return {
      receipts: validReceipts,
      blockNumbers,
      successCount: validReceipts.filter(r => r.status === 1).length,
      failCount: validReceipts.filter(r => r.status === 0).length,
    };
  }

  async sendParallelTxsWithNonce(
    users: User[],
    txFn: (user: User, nonce: number, index: number) => Promise<TransactionResponse>
  ): Promise<BatchTxResult> {
    const noncePromises = users.map(u => u.getNonce());
    const nonces = await Promise.all(noncePromises);

    const txPromises = users.map((user, index) => txFn(user, nonces[index], index));
    const txResponses = await Promise.all(txPromises);
    
    const receiptPromises = txResponses.map(tx => tx.wait());
    const receipts = await Promise.all(receiptPromises);

    const validReceipts = receipts.filter((r): r is TransactionReceipt => r !== null);
    const blockNumbers = validReceipts.map(r => r.blockNumber);
    
    return {
      receipts: validReceipts,
      blockNumbers,
      successCount: validReceipts.filter(r => r.status === 1).length,
      failCount: validReceipts.filter(r => r.status === 0).length,
    };
  }

  async burstErc20Transfers(
    txsPerUser: number,
    to: string,
    amount = ethers.parseEther('0.1')
  ): Promise<BatchTxResult> {
    const contract = this.getErc20();
    const allTxPromises: Promise<TransactionResponse>[] = [];

    const noncePromises = this.users.map(u => u.getNonce());
    const nonces = await Promise.all(noncePromises);

    for (let i = 0; i < this.users.length; i++) {
      const user = this.users[i];
      let nonce = nonces[i];
      
      for (let j = 0; j < txsPerUser; j++) {
        const connectedContract = contract.connect(user.wallet) as unknown as ERC20Contract;
        allTxPromises.push(
          connectedContract.transfer(to, amount, { nonce: nonce++ })
        );
      }
    }

    const txResponses = await Promise.all(allTxPromises);
    const receipts = await Promise.all(txResponses.map(tx => tx.wait()));
    
    const validReceipts = receipts.filter((r): r is TransactionReceipt => r !== null);
    const blockNumbers = validReceipts.map(r => r.blockNumber);
    
    return {
      receipts: validReceipts,
      blockNumbers,
      successCount: validReceipts.filter(r => r.status === 1).length,
      failCount: validReceipts.filter(r => r.status === 0).length,
    };
  }

  async burstNativeTransfers(
    txsPerUser: number,
    to: string,
    amount = ethers.parseEther('0.001')
  ): Promise<BatchTxResult> {
    const allTxPromises: Promise<TransactionResponse>[] = [];

    const noncePromises = this.users.map(u => u.getNonce());
    const nonces = await Promise.all(noncePromises);

    for (let i = 0; i < this.users.length; i++) {
      const user = this.users[i];
      let nonce = nonces[i];
      
      for (let j = 0; j < txsPerUser; j++) {
        allTxPromises.push(
          user.wallet.sendTransaction({ to, value: amount, nonce: nonce++ })
        );
      }
    }

    const txResponses = await Promise.all(allTxPromises);
    const receipts = await Promise.all(txResponses.map(tx => tx.wait()));
    
    const validReceipts = receipts.filter((r): r is TransactionReceipt => r !== null);
    const blockNumbers = validReceipts.map(r => r.blockNumber);
    
    return {
      receipts: validReceipts,
      blockNumbers,
      successCount: validReceipts.filter(r => r.status === 1).length,
      failCount: validReceipts.filter(r => r.status === 0).length,
    };
  }

  async getErc20Balances(): Promise<Map<string, bigint>> {
    const contract = this.getErc20();
    const balances = new Map<string, bigint>();
    
    const balancePromises = this.users.map(u => contract.balanceOf(u.address));
    const results = await Promise.all(balancePromises);
    
    this.users.forEach((user, i) => {
      balances.set(user.address, results[i]);
    });
    
    return balances;
  }

  async getNativeBalances(): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();
    
    const balancePromises = this.users.map(u => u.getBalance());
    const results = await Promise.all(balancePromises);
    
    this.users.forEach((user, i) => {
      balances.set(user.address, results[i]);
    });
    
    return balances;
  }

  getBlockStats(result: BatchTxResult): { 
    uniqueBlocks: number[]; 
    txsPerBlock: Map<number, number>;
    maxTxsInSingleBlock: number;
  } {
    const txsPerBlock = new Map<number, number>();
    
    for (const blockNum of result.blockNumbers) {
      txsPerBlock.set(blockNum, (txsPerBlock.get(blockNum) || 0) + 1);
    }
    
    const uniqueBlocks = [...txsPerBlock.keys()].sort((a, b) => a - b);
    const maxTxsInSingleBlock = Math.max(...txsPerBlock.values());
    
    return { uniqueBlocks, txsPerBlock, maxTxsInSingleBlock };
  }

  async buildLegacyTx(
    user: User,
    to: string,
    value: bigint = 0n,
    data: string = '0x',
    overrides?: { nonce?: number; gasPrice?: bigint; gasLimit?: bigint }
  ): Promise<TransactionRequest> {
    const feeData = await user.provider.getFeeData();
    const nonce = overrides?.nonce ?? await user.getNonce();
    
    return {
      type: 0,
      to,
      value,
      data,
      nonce,
      gasPrice: overrides?.gasPrice ?? feeData.gasPrice!,
      gasLimit: overrides?.gasLimit ?? 21000n,
    };
  }

  async buildAccessListTx(
    user: User,
    to: string,
    value: bigint = 0n,
    data: string = '0x',
    accessList: AccessList = [],
    overrides?: { nonce?: number; gasPrice?: bigint; gasLimit?: bigint }
  ): Promise<TransactionRequest> {
    const feeData = await user.provider.getFeeData();
    const nonce = overrides?.nonce ?? await user.getNonce();
    const { chainId } = await user.provider.getNetwork();
    
    return {
      type: 1,
      to,
      value,
      data,
      nonce,
      gasPrice: overrides?.gasPrice ?? feeData.gasPrice!,
      gasLimit: overrides?.gasLimit ?? 21000n,
      accessList,
      chainId,
    };
  }

  async buildEip1559Tx(
    user: User,
    to: string,
    value: bigint = 0n,
    data: string = '0x',
    overrides?: { nonce?: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasLimit?: bigint }
  ): Promise<TransactionRequest> {
    const feeData = await user.provider.getFeeData();
    const nonce = overrides?.nonce ?? await user.getNonce();
    const { chainId } = await user.provider.getNetwork();
    
    return {
      type: 2,
      to,
      value,
      data,
      nonce,
      maxFeePerGas: overrides?.maxFeePerGas ?? feeData.maxFeePerGas!,
      maxPriorityFeePerGas: overrides?.maxPriorityFeePerGas ?? feeData.maxPriorityFeePerGas!,
      gasLimit: overrides?.gasLimit ?? 21000n,
      chainId,
    };
  }

  async buildEip7702Tx(
    user: User,
    to: string,
    authorizationList: ethers.Authorization[],
    value: bigint = 0n,
    data: string = '0x',
    overrides?: { nonce?: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasLimit?: bigint }
  ): Promise<TransactionRequest> {
    const feeData = await user.provider.getFeeData();
    const nonce = overrides?.nonce ?? await user.getNonce();
    const { chainId } = await user.provider.getNetwork();
    
    return {
      type: 4,
      to,
      value,
      data,
      nonce,
      maxFeePerGas: overrides?.maxFeePerGas ?? feeData.maxFeePerGas!,
      maxPriorityFeePerGas: overrides?.maxPriorityFeePerGas ?? feeData.maxPriorityFeePerGas!,
      gasLimit: overrides?.gasLimit ?? 100000n,
      chainId,
      authorizationList,
    };
  }


  async sendLegacyTx(
    user: User,
    to: string,
    value: bigint = 0n,
    data: string = '0x',
    overrides?: { nonce?: number; gasPrice?: bigint; gasLimit?: bigint }
  ): Promise<TransactionResponse> {
    const tx = await this.buildLegacyTx(user, to, value, data, overrides);
    return user.wallet.sendTransaction(tx);
  }

  async sendAccessListTx(
    user: User,
    to: string,
    value: bigint = 0n,
    data: string = '0x',
    accessList: AccessList = [],
    overrides?: { nonce?: number; gasPrice?: bigint; gasLimit?: bigint }
  ): Promise<TransactionResponse> {
    const tx = await this.buildAccessListTx(user, to, value, data, accessList, overrides);
    return user.wallet.sendTransaction(tx);
  }

  async sendEip1559Tx(
    user: User,
    to: string,
    value: bigint = 0n,
    data: string = '0x',
    overrides?: { nonce?: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasLimit?: bigint }
  ): Promise<TransactionResponse> {
    const tx = await this.buildEip1559Tx(user, to, value, data, overrides);
    return user.wallet.sendTransaction(tx);
  }

  async sendEip7702Tx(
    user: User,
    to: string,
    authorizationList: ethers.Authorization[],
    value: bigint = 0n,
    data: string = '0x',
    overrides?: { nonce?: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasLimit?: bigint }
  ): Promise<TransactionResponse> {
    const tx = await this.buildEip7702Tx(user, to, authorizationList, value, data, overrides);
    return user.wallet.sendTransaction(tx);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Parallel Sends by Transaction Type
  // ─────────────────────────────────────────────────────────────────────────────

  async sendParallelLegacyTxs(
    to: string,
    value: bigint = ethers.parseEther('0.01')
  ): Promise<BatchTxResult> {
    const feeData = await this.users[0].provider.getFeeData();
    const noncePromises = this.users.map(u => u.getNonce());
    const nonces = await Promise.all(noncePromises);

    return this.sendParallelTxs(
      this.users,
      (user, index) => user.wallet.sendTransaction({
        type: 0,
        to,
        value,
        nonce: nonces[index],
        gasPrice: feeData.gasPrice!,
        gasLimit: 21000n,
      })
    );
  }

  async sendParallelAccessListTxs(
    to: string,
    value: bigint = ethers.parseEther('0.01'),
    accessList: AccessList = []
  ): Promise<BatchTxResult> {
    const feeData = await this.users[0].provider.getFeeData();
    const { chainId } = await this.users[0].provider.getNetwork();
    const noncePromises = this.users.map(u => u.getNonce());
    const nonces = await Promise.all(noncePromises);

    return this.sendParallelTxs(
      this.users,
      (user, index) => user.wallet.sendTransaction({
        type: 1,
        to,
        value,
        nonce: nonces[index],
        gasPrice: feeData.gasPrice!,
        gasLimit: 21000n,
        accessList,
        chainId,
      })
    );
  }

  async sendParallelEip1559Txs(
    to: string,
    value: bigint = ethers.parseEther('0.01')
  ): Promise<BatchTxResult> {
    const feeData = await this.users[0].provider.getFeeData();
    const { chainId } = await this.users[0].provider.getNetwork();
    const noncePromises = this.users.map(u => u.getNonce());
    const nonces = await Promise.all(noncePromises);

    return this.sendParallelTxs(
      this.users,
      (user, index) => user.wallet.sendTransaction({
        type: 2,
        to,
        value,
        nonce: nonces[index],
        maxFeePerGas: feeData.maxFeePerGas!,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
        gasLimit: 21000n,
        chainId,
      })
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // EIP-7702 Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  async createAuthorization(
    user: User,
    contractAddress: string,
    chainIdOverride?: bigint,
    nonceOverride?: number
  ): Promise<ethers.Authorization> {
    const { chainId } = await user.provider.getNetwork();
    const nonce = nonceOverride ?? (await user.getNonce()) + 1;
    
    return user.wallet.authorize({
      address: contractAddress,
      chainId: (chainIdOverride ?? chainId) as any,
      nonce: nonce as any,
    });
  }

  async setCodeForUser(
    user: User,
    contractAddress: string,
    sender?: User
  ): Promise<TransactionReceipt | null> {
    const auth = await this.createAuthorization(user, contractAddress);
    const txSender = sender ?? user;
    
    const tx = await this.sendEip7702Tx(
      txSender,
      user.address,
      [auth],
      0n,
      '0x'
    );
    return tx.wait();
  }

  async clearCodeForUser(user: User): Promise<TransactionReceipt | null> {
    return this.setCodeForUser(user, ethers.ZeroAddress);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Block Gas Limit & Gas Burning
  // ─────────────────────────────────────────────────────────────────────────────

  async getBlockGasLimit(): Promise<bigint> {
    const block = await this.users[0].provider.getBlock('latest');
    if (!block) throw new Error('Failed to fetch latest block');
    return block.gasLimit;
  }

  async getBlockInfo(blockNumber: number | 'latest' = 'latest'): Promise<{
    number: number;
    gasLimit: bigint;
    gasUsed: bigint;
    txCount: number;
    fillPercentage: number;
  }> {
    const block = await this.users[0].provider.getBlock(blockNumber);
    if (!block) throw new Error(`Failed to fetch block ${blockNumber}`);
    
    const fillPercentage = Number((block.gasUsed * 10000n) / block.gasLimit) / 100;
    
    return {
      number: block.number,
      gasLimit: block.gasLimit,
      gasUsed: block.gasUsed,
      txCount: block.transactions.length,
      fillPercentage,
    };
  }

  async estimateGasBurnerGas(user: User): Promise<bigint> {
    const contract = this.getGasBurner();
    const address = await contract.getAddress();
    return user.provider.estimateGas({
      to: address,
      data: contract.interface.encodeFunctionData('burnGasOverMaxLimit', [0n]),
      from: user.address,
    });
  }

  async burnGasParallel(salt: bigint = 0n): Promise<BatchTxResult> {
    const contract = this.getGasBurner();
    return this.sendParallelTxs(
      this.users,
      (user, index) => {
        const connectedContract = contract.connect(user.wallet) as unknown as GasBurnerContract;
        return connectedContract.burnGasOverMaxLimit(salt + BigInt(index));
      }
    );
  }

  async burnGasWithIterations(
    user: User,
    iterations: bigint,
    salt: bigint = 0n,
    gasLimit?: bigint
  ): Promise<TransactionResponse> {
    const contract = this.getGasBurner();
    const connectedContract = contract.connect(user.wallet) as unknown as GasBurnerContract;
    
    const overrides: TxOverrides = {};
    if (gasLimit) {
      overrides.gasLimit = gasLimit;
    }
    
    return connectedContract.burnGasIterations(salt, iterations, overrides);
  }

  async fillBlockToPercentage(
    targetPercentage: number,
    user?: User
  ): Promise<BlockFillResult> {
    if (targetPercentage < 0 || targetPercentage > 100) {
      throw new Error('Target percentage must be between 0 and 100');
    }

    const sender = user ?? this.users[0];
    const blockGasLimit = await this.getBlockGasLimit();
    const targetGas = (blockGasLimit * BigInt(Math.floor(targetPercentage * 100))) / 10000n;
    
    const contract = this.getGasBurner();
    const connectedContract = contract.connect(sender.wallet) as unknown as GasBurnerContract;
    
    const estimatedGasPerCall = await this.estimateGasBurnerGas(sender);
    const numCalls = Number(targetGas / estimatedGasPerCall) || 1;
    
    const nonce = await sender.getNonce();
    const txPromises: Promise<TransactionResponse>[] = [];
    
    for (let i = 0; i < numCalls; i++) {
      txPromises.push(
        connectedContract.burnGasOverMaxLimit(BigInt(Date.now() + i), { nonce: nonce + i })
      );
    }
    
    const txResponses = await Promise.all(txPromises);
    const receipts = await Promise.all(txResponses.map(tx => tx.wait()));
    
    const validReceipts = receipts.filter((r): r is TransactionReceipt => r !== null);
    const blockNumber = validReceipts[0]?.blockNumber ?? 0;
    
    const blockInfo = await this.getBlockInfo(blockNumber);
    
    return {
      blockNumber,
      txCount: validReceipts.length,
      gasUsed: blockInfo.gasUsed,
      gasLimit: blockInfo.gasLimit,
      fillPercentage: blockInfo.fillPercentage,
    };
  }

  async fillBlocksToPercentage(
    numBlocks: number,
    targetPercentage: number,
    delayBetweenBlocksMs: number = 500
  ): Promise<FillBlocksResult> {
    const results: BlockFillResult[] = [];
    let totalGasUsed = 0n;
    let totalTxs = 0;

    for (let i = 0; i < numBlocks; i++) {
      const userIndex = i % this.users.length;
      const result = await this.fillBlockToPercentage(targetPercentage, this.users[userIndex]);
      results.push(result);
      totalGasUsed += result.gasUsed;
      totalTxs += result.txCount;
      
      if (i < numBlocks - 1 && delayBetweenBlocksMs > 0) {
        await this.sleep(delayBetweenBlocksMs);
      }
    }

    const averageFillPercentage = results.reduce((sum, r) => sum + r.fillPercentage, 0) / results.length;

    return {
      blocks: results,
      totalTxs,
      totalGasUsed,
      averageFillPercentage,
    };
  }

  async burstGasBurn(
    txsPerUser: number,
    salt: bigint = 0n
  ): Promise<BatchTxResult> {
    const contract = this.getGasBurner();
    const allTxPromises: Promise<TransactionResponse>[] = [];

    const noncePromises = this.users.map(u => u.getNonce());
    const nonces = await Promise.all(noncePromises);

    for (let i = 0; i < this.users.length; i++) {
      const user = this.users[i];
      let nonce = nonces[i];
      const connectedContract = contract.connect(user.wallet) as unknown as GasBurnerContract;
      
      for (let j = 0; j < txsPerUser; j++) {
        allTxPromises.push(
          connectedContract.burnGasOverMaxLimit(salt + BigInt(i * txsPerUser + j), { nonce: nonce++ })
        );
      }
    }

    const txResponses = await Promise.all(allTxPromises);
    const receipts = await Promise.all(txResponses.map(tx => tx.wait()));
    
    const validReceipts = receipts.filter((r): r is TransactionReceipt => r !== null);
    const blockNumbers = validReceipts.map(r => r.blockNumber);
    
    return {
      receipts: validReceipts,
      blockNumbers,
      successCount: validReceipts.filter(r => r.status === 1).length,
      failCount: validReceipts.filter(r => r.status === 0).length,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

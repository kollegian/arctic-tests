import {BaseApiClient} from "./BaseApiClient";
import {LedgerMovement, UserProfile} from "../../types";
import {SeiUser} from "../../../../shared/User";
import {string} from "hardhat/internal/core/params/argumentTypes";
import {TransactionReceipt} from "ethers";

export class AccountsClient extends BaseApiClient {
    private ledgerHolder = new Map<string, UserProfile>();
    private userBalanceHolder = new Map<string, [{ tokenAddress: string, balance: string }]>();

    constructor(url: string, clientId: string) {
        super(url, clientId);
    }

    async queryAccountData(accessToken: string): Promise<Response> {
        const url = `${this.url}/api/v1/accounts/me`;
        const options = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
        }
        return await fetch(url, options);
    }

    async queryAccountMovements(accessToken: string, page: number = 1, limit: number = 20) {
        const url = `${this.url}/api/v1/accounts/movements?$page=${page}&limit=${limit}`;
        const options = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
        }
        return await fetch(url, options);
    }

    async createSubAccount(accessToken: string, subAccountName: string, subAccountDescription: string) {
        const url = `${this.url}/api/v1/accounts/sub-accounts`;
        const body = JSON.stringify({
            "name": subAccountName,
            "description": subAccountDescription
        });
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
        }
        return await fetch(url, options);
    }

    initiateUserRecord(user: SeiUser, existingData?: UserProfile): UserProfile {
        const userRecord: UserProfile = existingData || {
            id: '',
            address: user.evmAddress.toLowerCase(),
            username: null,
            account_type: 'master',
            can_withdraw: true,
            created_at: '',
            balances: [],
            recent_movements: [],
            recent_orders: [],
        };
        this.ledgerHolder.set(user.evmAddress, userRecord);
        return userRecord;
    }

    updateUserRecord(user: SeiUser, userRecord: UserProfile): void {
        this.ledgerHolder.set(user.evmAddress, userRecord);
    }

    setMissingRecords(userAddress: string, userId: string, createdAt: string): void {
        const userRecord = this.ledgerHolder.get(userAddress);
        if (!userRecord) {
            throw new Error(`User record not found for address: ${userAddress}`);
        }
        userRecord.id = userId;
        userRecord.created_at = createdAt;
        this.ledgerHolder.set(userAddress, userRecord);
    }

    getUserRecord(userAddress: string): UserProfile | undefined {
        return this.ledgerHolder.get(userAddress);
    }

    setPreviousUserBalance(user: SeiUser, tokenAddress: string){
        const userRecord = this.ledgerHolder.get(user.evmAddress);
        const balances = userRecord!.balances.find(b => b.token === tokenAddress.toLowerCase());
        if (!balances){
            this.userBalanceHolder.set(user.evmAddress, [{
                tokenAddress: tokenAddress.toLowerCase(),
                balance: '0'
            }]);
        } else {
            this.userBalanceHolder.set(user.evmAddress, [{
                tokenAddress: tokenAddress.toLowerCase(),
                balance: balances.available_balance
            }]);
        }
    }

    addBalanceToUserRecord(user: SeiUser, tokenAddress: string, amount: string): void {
        const userRecord = this.ledgerHolder.get(user.evmAddress);
        this.setPreviousUserBalance(user, tokenAddress);
        if (!userRecord) {
            throw new Error(`User record not found for address: ${user.evmAddress}`);
        }

        const existingBalance = userRecord.balances.find(b => b.token === tokenAddress.toLowerCase());
        if (existingBalance) {
            const newBalance = BigInt(existingBalance.available_balance) + BigInt(amount);
            existingBalance.available_balance = newBalance.toString();
            existingBalance.total_balance = newBalance.toString();
        } else {
            userRecord.balances.unshift({
                token: tokenAddress.toLowerCase(),
                available_balance: amount,
                locked_balance: '0',
                total_balance: amount
            });
        }
        this.ledgerHolder.set(user.evmAddress, userRecord);
    }

    addRecentMovementEntry(testUser: SeiUser, contractAddress: string, depositAmount: string, accountData: UserProfile, txType: string, tx: TransactionReceipt) {
        const balanceBefore = (this.userBalanceHolder.get(testUser.evmAddress))?.find((tokenData) => tokenData.tokenAddress === contractAddress.toLowerCase());
        const balanceAfter = accountData.balances.find(b => b.token === contractAddress.toLowerCase())!.available_balance;
        const movementEntry = accountData.recent_movements.find(m => m.tx_hash === tx.hash)!;
        let entryType = 'Withdrawal'
        if (txType === 'Deposit') {
            entryType = 'Credit';
        }
        const recentEntry = {
            id: movementEntry.id,
            entry_type: entryType,
            transaction_type: txType,
            amount: depositAmount,
            token: contractAddress.toLowerCase(),
            balance_before: balanceBefore!.balance,
            balance_after: balanceAfter,
            locked_before: '0',
            locked_after: '0',
            reference_id: null,
            reference_type: null,
            description: `Deposit of ${depositAmount} raw units`,
            tx_hash: tx.hash,
            block_number: tx.blockNumber,
            created_at: movementEntry.created_at,
        };
        const userData = this.ledgerHolder.get(testUser.evmAddress)!;
        userData.recent_movements.unshift(recentEntry);
        this.ledgerHolder.set(testUser.evmAddress, userData);
    }
}

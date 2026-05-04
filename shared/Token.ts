import util from "node:util";
import { SeiUser } from "./User";
import { ethers, Contract, BigNumberish } from "ethers";
import {calculateFee, DeliverTxResponse, StdFee} from "@cosmjs/stargate";
import {ExecuteInstruction, ExecuteResult} from "@cosmjs/cosmwasm-stargate";

import ERC20_ARTIFACT from '../artifacts/contracts/TestERC20.sol/TestERC20.json';
import ERC721_ARTIFACT from '../artifacts/contracts/TestNFT.sol/TestNFT.json';
import ERC1155_ARTIFACT from '../artifacts/contracts/TestERC1155.sol/TestERC1155.json';
import {TestERC20, TestNFT} from "../typechain-types";

const exec = util.promisify(require('node:child_process').exec);
import {waitFor} from "./utils/helpers";
import {execCommandAndReturnJson} from "./utils/cliUtils";
import {EncodeObject} from "@cosmjs/proto-signing";
import {TxRaw} from "cosmjs-types/cosmos/tx/v1beta1/tx";
import {BroadcastTxResponse} from "cosmjs-types/cosmos/tx/v1beta1/service";


export interface IFungibleToken {
    name(): Promise<string>;
    symbol(): Promise<string>;
    decimals(): Promise<number>;
    totalSupply(): Promise<BigNumberish | string>;
    balanceOf(address?: string): Promise<BigNumberish | string>;
    transfer(to: string, amount: BigNumberish | string): Promise<any>;
    approve(spender: string, amount: BigNumberish | string): Promise<any>;
    allowance(owner: string, spender: string): Promise<BigNumberish | string>;
}

export interface INft721 {
    name(): Promise<string>;
    symbol(): Promise<string>;
    balanceOf(owner?: string): Promise<BigNumberish>;
    ownerOf(tokenId: BigNumberish | string): Promise<string>;
    safeTransferFrom(from: string, to: string, tokenId: BigNumberish | string): Promise<any>;
    transfer(from: string, to: string, tokenId: BigNumberish | string): Promise<any>;
    approve(to: string, tokenId: BigNumberish | string): Promise<any>;
    getApproved(tokenId: BigNumberish | string): Promise<string>;
    setApprovalForAll(operator: string, approved: boolean): Promise<any>;
    isApprovedForAll(owner: string, operator: string): Promise<boolean>;
}

export interface INft1155 {
    uri(tokenId: BigNumberish | string): Promise<string>;
    balanceOf(account: string, tokenId: BigNumberish | string): Promise<BigNumberish>;
    balanceOfBatch(accounts: string[], tokenIds: (BigNumberish | string)[]): Promise<BigNumberish[]>;
    setApprovalForAll(operator: string, approved: boolean): Promise<any>;
    isApprovedForAll(account: string, operator: string): Promise<boolean>;
    safeTransferFrom(from: string, to: string, tokenId: BigNumberish | string, amount: BigNumberish | string, data?: string | Uint8Array): Promise<any>;
    safeBatchTransferFrom(from: string, to: string, tokenIds: (BigNumberish | string)[], amounts: (BigNumberish | string)[], data?: string | Uint8Array): Promise<any>;
}


abstract class EvmTokenBase {
    protected constructor(protected user: SeiUser, public contract: Contract) {}
}

export class Erc20Token extends EvmTokenBase implements IFungibleToken {
    constructor(user: SeiUser, address: string) {
        super(user, new ethers.Contract(address, ERC20_ARTIFACT.abi, user.evmWallet.wallet));
    }
    getAddress() { return this.contract.target; }
    name() { return this.contract.name(); }
    symbol() { return this.contract.symbol(); }
    decimals() { return this.contract.decimals(); }
    totalSupply() { return this.contract.totalSupply(); }
    balanceOf(address?: string) { return this.contract.balanceOf(address ?? this.user.evmAddress); }
    transfer(to: string, amount: BigNumberish) { return this.contract.transfer(to, amount); }
    transferFrom(from: string, to: string, amount: BigNumberish) { return this.contract.transferFrom(from, to, amount); }
    approve(spender: string, amount: BigNumberish) { return this.contract.approve(spender, amount); }
    allowance(owner: string, spender: string) { return this.contract.allowance(owner, spender); }
    mint(to: string, amount: string){return this.contract.mint(to, amount)}
    async mintToUsers(users: SeiUser[], amount = '100'){
        const txs = [];
        for (const user of users) {
            txs.push(this.contract.connect(user.evmWallet.wallet).mint(user.evmAddress, ethers.parseEther(amount)));
        }
        const txRequests = await Promise.all(txs);
        return await Promise.all(txRequests.map(tx => tx.wait()));
    }
    async deployPointer(evmRpcEndpoint: string){
        console.info(`Deploying pointer for ${(this.contract.target)} on ${evmRpcEndpoint}`);
        await exec(`seid tx evm register-cw-pointer ERC20 ${(this.contract.target)} --from admin --fees 24200usei -y`);
        await waitFor(2);
        const {stdout} = await exec(`seid q evm pointer ERC20 ${this.contract.target} --output json`);
        return JSON.parse(stdout).pointer;
    }

    async sendMultipleTxs(users: SeiUser[]){
        const txs = [];
        for(const user of users){
            txs.push(this.contract
                .connect(user.evmWallet.wallet).transfer(this.user.evmAddress, ethers.parseEther('0.01'), {gasLimit: 500000, gasPrice: ('1500000000000')}));
        }
        const txRequests = await Promise.all(txs);
        return await Promise.all(txRequests.map((request: { wait: () => any; }) => request.wait()));
    }
}


export class Cw20Token implements IFungibleToken {
    constructor(private user: SeiUser, private address: string, private fee: StdFee = calculateFee(450000, '0.25usei')) {}

    private query<T>(msg: object): Promise<T> {
        return this.user.seiWallet.cosmWasmSigningClient.queryContractSmart(this.address, msg) as Promise<T>;
    }
    private exec(msg: object, memo = ""): Promise<ExecuteResult> {
        return this.user.seiWallet.cosmWasmSigningClient.execute(
            this.user.seiAddress,
            this.address,
            msg,
            this.fee,
            memo
        );
    }

    sign(
        signer: SeiUser,
        msg: EncodeObject,
        signerData? : {
            readonly accountNumber: number
            readonly sequence: number
            readonly chainId: string
        },
    ): Promise<TxRaw> {

        return signer.seiWallet.cosmWasmSigningClient.sign(
            signer.seiAddress,
            [msg],
            this.fee,
            "memo",
            signerData,
        );
    }


    broadcastTx(sender: SeiUser, tx: TxRaw): Promise<string> {
        const txRawBinary: Uint8Array = TxRaw.encode(tx).finish();
        return sender.seiWallet.cosmWasmSigningClient.broadcastTxSync(txRawBinary);
    }

    execMultiple(msgs: ExecuteInstruction[], memo = ""): Promise<ExecuteResult> {
        const fee = calculateFee(4500000, '1usei');
        return this.user.seiWallet.cosmWasmSigningClient.executeMultiple(
            this.user.seiAddress,
            msgs,
            fee,
        )
    }

    getAddress() { return this.address};
    setSigner(newSigner: SeiUser) {this.user = newSigner;}
    async name() { const res = await this.query<{ name: string }>({ name: {} }); return res.name; }
    async symbol() { const res = await this.query<{ symbol: string }>({ symbol: {} }); return res.symbol; }
    async decimals() { const res = await this.query<{ decimals: number }>({ decimals: {} }); return res.decimals; }
    async totalSupply() { const res = await this.query<{ total_supply: string }>({ total_supply: {} }); return res.total_supply; }
    async balanceOf(address?: string) { const res = await this.query<{ balance: string }>({ balance: { address: address ?? this.user.seiAddress } }); return res.balance; }
    async tokenInfo() { const res = await this.query<{ token_info: { name: string, symbol: string, decimals: number, total_supply: string } }>({ token_info: {} }); return res.token_info;}
    transfer(to: string, amount: string | number) { return this.exec({ transfer: { recipient: to, amount: amount.toString() } }); }
    transferFromSender(from: SeiUser, to: string, amount: string | number) {
        const msg = {transfer: { recipient: to, amount: amount.toString()}};
        return from.seiWallet.cosmWasmSigningClient.execute(
            from.seiAddress,
            this.address,
            msg,
            this.fee,
            'memo'
        );
    }
    returnEncodedTransfer(sender: SeiUser, recipient: string, amount: string): EncodeObject {
        const transferMsg = {
            transfer: {
                recipient: recipient,
                amount: amount
            }
        };

        return {
            typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
            value: {
                sender: sender.seiAddress,
                contract: this.address,
                msg: Buffer.from(JSON.stringify(transferMsg)),
                funds: []
            }
        };
    }

    approve(spender: string, amount: string | number) { return this.exec({ increase_allowance: { spender, amount: amount.toString() } }); }
    allowance(owner: string, spender: string) { return this.query<{ allowance: string }>({ allowance: { owner, spender } }).then(r => r.allowance); }
    async mint(to: string, amount: string | number) {
        return this.exec({ mint: { recipient: to, amount: amount.toString() } });
    }
    async burn(amount: string | number) {
        return this.exec({ burn: { amount: amount.toString() } });
    }
    async transferFrom(owner: string, recipient: string, amount: string | number) {
        return this.exec({ transfer_from: { owner, recipient, amount: amount.toString() } });
    }
    async decreaseAllowance(spender: string, amount: string | number) {
        return this.exec({ decrease_allowance: { spender, amount: amount.toString() } });
    }
    async mintMultiple(recipients: string[], amounts: string[]): Promise<ExecuteResult> {
        if (recipients.length !== amounts.length) {
            throw new Error("Recipients and amounts arrays must be the same length");
        }

        const messages: ExecuteInstruction[] = recipients.map((recipient, i) => ({
            contractAddress: this.address,
            msg: {
                mint: {
                    recipient: recipient,
                    amount: amounts[i]
                }
            }
        }));
        return this.execMultiple(messages, '');
    }

    async deployPointer(evmEndpoint: string){
        const resp = await exec(`seid tx evm register-evm-pointer CW20 ${this.address} --evm-rpc=${evmEndpoint} --from admin -y --gas-limit 4900000 --broadcast-mode block`);
        console.log(resp);
    }
    async queryPointerAddress(){
        const {stdout, stderror} = await exec(`seid q evm pointer CW20 ${this.address} --output json`);
        console.log(stdout);
        console.log(stderror);
        return (JSON.parse(stdout)).pointer;
    }

    async executeMultipleInTheSameBlock(sender: SeiUser, cw20ContractAddress: string, msgs: object[], chainId: string) {
        await waitFor(1);
        const fileNames = ['./tests/tokens/firstTx.json', './tests/tokens/secondTx.json'];
        const preSequence = await execCommandAndReturnJson(`seid query account ${sender.seiAddress}`);
        for (const msg of msgs) {
            const index = msgs.indexOf(msg);
            const fileName = fileNames[index];
            await exec(`seid tx wasm execute ${cw20ContractAddress} '${JSON.stringify(msg)}' --from ${sender.seiAddress} --fees 24200usei -y --generate-only > ${fileName}`);
        }

        await exec(`seid tx sign ${fileNames[0]} --from ${sender.seiAddress} --chain-id ${chainId} > ./tests/tokens/firstTxSigned.json`);
        await exec(`seid tx sign ${fileNames[1]} --from ${sender.seiAddress} --chain-id ${chainId} --sequence ${Number(preSequence.sequence) + 1} --offline --account-number ${preSequence.account_number} > ./tests/tokens/secondTxSigned.json`);

        const broadcast1 = exec(`seid tx broadcast ./tests/tokens/firstTxSigned.json --output json`);
        await waitFor(0.1);
        const broadcast2 = exec(`seid tx broadcast ./tests/tokens/secondTxSigned.json --output json`);
        return await Promise.all([broadcast1, broadcast2]);
    }

}

export class Erc721Token extends EvmTokenBase implements INft721 {
    constructor(user: SeiUser, address: string) {
        super(user, new ethers.Contract(address, ERC721_ARTIFACT.abi, user.evmWallet.wallet));
    }

    name(): Promise<string> {
        return this.contract.name();
    }

    symbol(): Promise<string> {
        return this.contract.symbol();
    }

    owner(): Promise<string> {
        return this.contract.owner();
    }

    balanceOf(owner?: string): Promise<BigNumberish> {
        return this.contract.balanceOf(owner ?? this.user.evmAddress);
    }

    ownerOf(tokenId: BigNumberish): Promise<string> {
        return this.contract.ownerOf(tokenId);
    }

    totalSupply(): Promise<BigNumberish> {
        return this.contract.totalSupply();
    }

    tokenByIndex(index: BigNumberish): Promise<BigNumberish> {
        return this.contract.tokenByIndex(index);
    }

    tokenOfOwnerByIndex(owner: string, index: BigNumberish): Promise<BigNumberish> {
        return this.contract.tokenOfOwnerByIndex(owner, index);
    }

    supportsInterface(interfaceId: string): Promise<boolean> {
        return this.contract.supportsInterface(interfaceId);
    }

    renounceOwnership(): Promise<any> {
        return this.contract.renounceOwnership();
    }

    transferOwnership(newOwner: string): Promise<any> {
        return this.contract.transferOwnership(newOwner);
    }

    safeMint(to: string, tokenId: BigNumberish): Promise<any> {
        return this.contract.safeMint(to, tokenId);
    }

    transferFrom(from: string, to: string, tokenId: BigNumberish): Promise<any> {
        return this.contract.transferFrom(from, to, tokenId);
    }

    transfer(from: string, to: string, tokenId: BigNumberish): Promise<any> {
        return this.contract.transferFrom(from, to, tokenId);
    }

    safeTransferFrom(from: string, to: string, tokenId: BigNumberish): Promise<any> {
        return this.contract['safeTransferFrom(address,address,uint256)'](from, to, tokenId);
    }

    safeTransferFromWithData(from: string, to: string, tokenId: BigNumberish, data: string | Uint8Array): Promise<any> {
        return this.contract['safeTransferFrom(address,address,uint256,bytes)'](from, to, tokenId, data);
    }

    approve(to: string, tokenId: BigNumberish): Promise<any> {
        return this.contract.approve(to, tokenId);
    }

    getApproved(tokenId: BigNumberish): Promise<string> {
        return this.contract.getApproved(tokenId);
    }

    setApprovalForAll(operator: string, approved: boolean): Promise<any> {
        return this.contract.setApprovalForAll(operator, approved);
    }

    isApprovedForAll(owner: string, operator: string): Promise<boolean> {
        return this.contract.isApprovedForAll(owner, operator);
    }

    getContract(): TestNFT {
        return this.contract as unknown as TestNFT;
    }

    returnNextId(): Promise<BigNumberish> {
        return this.contract.totalSupply();
    }

    setSigner(signer: SeiUser){
        this.user = signer;
    }

    getAddress(){
        return this.contract.target;
    }

    async registerPointer() {
        const resp = await exec(`seid tx evm register-cw-pointer ERC721 ${this.contract.target} --from admin -y --fees 24200usei --broadcast-mode block`);
        await waitFor(1);
        const {stdout, stderr} = await exec(`seid q evm pointer ERC721 ${this.contract.target} --output json`);
        return (JSON.parse(stdout)).pointer;
    }
}

/**
 * CW721 Token wrapper
 */
export class Cw721Token implements INft721 {
    constructor(private user: SeiUser, private address: string, private fee: StdFee = user.seiWallet.fee) {}

    private query<T>(msg: object): Promise<T> {
        return this.user.seiWallet.cosmWasmSigningClient.queryContractSmart(this.address, msg) as Promise<T>;
    }

    private exec(msg: object, memo = ""): Promise<ExecuteResult> {
        this.fee = calculateFee(300000, '0.25usei');
        return this.user.seiWallet.cosmWasmSigningClient.execute(
            this.user.seiAddress,
            this.address,
            msg,
            this.fee,
            memo
        );
    }

    private execMultiple(msgs: ExecuteInstruction[], memo = ""): Promise<ExecuteResult> {
        const fee = calculateFee(3000000, '0.25usei');
        return this.user.seiWallet.cosmWasmSigningClient.executeMultiple(
            this.user.seiAddress,
            msgs,
            fee,
        )
    }

    getAddress() { return this.address};
    setSigner(newSigner: SeiUser) {this.user = newSigner;}
    async name() { const r = await this.query<{ name: string }>({ name: {} }); return r.name; }
    async symbol() { const r = await this.query<{ symbol: string }>({ symbol: {} }); return r.symbol; }
    async balanceOf(owner?: string) { const r = await this.query<{ balance: string }>({ tokens: { owner: owner ?? this.user.seiAddress, start_after: null, limit: 1 } }); return r.balance; }
    async ownerOf(tokenId: string) { const r = await this.query<{ owner: string }>({ owner_of: { token_id: tokenId } }); return r.owner; }
    safeTransferFrom(from: string, to: string, tokenId: string) { return this.exec({ transfer_nft: { recipient: to, token_id: tokenId } }); }
    transfer(from: string, to: string, tokenId: string) { return this.exec({ transfer_nft: { recipient: to, token_id: tokenId } }); }
    sendNft(to: string, tokenId: string, msg?: string) { return this.exec({ send_nft: { contract: to, token_id: tokenId, msg: msg || "" } }); }
    approve(to: string, tokenId: string) { return this.exec({ approve: { spender: to, token_id: tokenId } }); }
    revokeApproval(spender: string, tokenId: string) { return this.exec({ revoke: { spender: spender, token_id: tokenId } }); }
    getApproved(tokenId: string) { return this.query<{ approvals: { spender: string, expires: any }[] }>({ approvals: { token_id: tokenId, include_expired: true } }).then(r => r.approvals.length > 0 ? r.approvals[0].spender : ''); }
    setApprovalForAll(operator: string, approved: boolean) { return this.exec({ approve_all: { operator, expires: null } }); }
    revokeAll(operator: string) { return this.exec({ revoke_all: { operator } }); }
    isApprovedForAll(owner: string, operator: string) { return this.query<{ approved: boolean }>({ approvals: { owner, operator } }).then(r => r.approved); }
    tokenUri(tokenId: string) { return this.query<{ token_uri: string }>({ nft_info: { token_id: tokenId } }).then(r => r.token_uri); }
    mintTx(nftId: string, receiverAddress: string) { return this.exec({ mint: { token_id: nftId, owner: receiverAddress, token_uri: `https://example.com/token${nftId}.json`, extension: { royalty_percentage: 10, royalty_payment_address: this.user.seiAddress } } }); }
    mint(tokenId: string, receiverAddress: string) { return this.exec({ mint: { token_id: tokenId, owner: receiverAddress, token_uri: `https://example.com/token${tokenId}.json`, extension: { royalty_percentage: 10, royalty_payment_address: this.user.seiAddress } } }); }
    burn(tokenId: string) { return this.exec({ burn: { token_id: tokenId } }); }
    mintMultiple(nftIds: string[], receiverAddresses: string[]) {
        const messages: ExecuteInstruction[] = nftIds.map((nftId, i) => ({
            contractAddress: this.address,
            msg: {
                mint: {
                    token_id: nftId,
                    owner: receiverAddresses[i],
                    token_uri: `https://example.com/token${nftId}.json`,
                    extension: { royalty_percentage: 10, royalty_payment_address: this.user.seiAddress }
                }
            }
        }));
        return this.execMultiple(messages, '');}
    async deployPointer(evmEndpoint: string){
        const resp = await exec(`seid tx evm register-evm-pointer CW721 ${this.address} --evm-rpc=${evmEndpoint} --from admin -y --gas-limit 4500000 --broadcast-mode block`);
        await waitFor(1);
        const {stdout, stderr} = await exec(`seid q evm pointer CW721 ${this.address} --output json`);
        return (JSON.parse(stdout)).pointer;
    }
    async queryPointerAddress(){
        const {stdout, stderror} = await exec(`seid q evm pointer CW721 ${this.address} --output json`);
        console.log(stdout);
        return (JSON.parse(stdout)).pointer;
    }

    async queryApprovals(nftId: number){
        return await this.user.seiWallet.cosmWasmSigningClient.queryContractSmart(
            this.address,
            {
                approvals: {
                    token_id: nftId.toString(),
                    include_expired: true
                }
            }
        );
    }
    async queryRoyaltyInfo(tokenId: string, salePrice: string) {
        return this.query<{ address: string, royalty_amount: string } >({
            extension: {
                msg: { royalty_info: { token_id: tokenId, sale_price: salePrice } }
            }
        });
    }

    // Extension methods for royalties
    async checkRoyalties() {
        return this.query<{ royalty_payments: string }>({
            extension: {
                msg: { check_royalties: {} }
            }
        });
    }

    async getRoyaltyInfo(tokenId: string, salePrice: string) {
        return this.query<{ address: string, royalty_amount: string }>({
            extension: {
                msg: { royalty_info: { token_id: tokenId, sale_price: salePrice } }
            }
        });
    }

    // Ownership management methods
    async getContractOwner() {
        return this.query<{ owner: string }>({ ownership: {} }).then(r => r.owner);
    }

    async updateOwnership(newOwner: string) {
        return this.exec({ update_ownership: { new_owner: newOwner } });
    }

    // Withdrawal methods for royalties
    async setWithdrawAddress(address: string) {
        return this.exec({ set_withdraw_address: { address } });
    }

    async removeWithdrawAddress() {
        return this.exec({ remove_withdraw_address: {} });
    }

    async withdrawFunds() {
        return this.exec({ withdraw_funds: {} });
    }

    async getWithdrawAddress() {
        return this.query<{ address: string }>({ withdraw_address: {} }).then(r => r.address);
    }

    // Helper methods for dynamic token management
    async getTotalSupply(): Promise<number> {
        const r = await this.query<{ count: string }>({ num_tokens: {} });
        return parseInt(r.count);
    }

    async getAllTokensForOwner(owner: string): Promise<string[]> {
        const tokens: string[] = [];
        let startAfter: string | null = null;
        const limit = 30; // reasonable limit per query

        while (true) {
            const query: any = {
                tokens: {
                    owner,
                    limit,
                    start_after: startAfter
                }
            };

            const r = await this.query<{ tokens: string[] }>(query);

            if (r.tokens.length === 0) {
                break;
            }

            tokens.push(...r.tokens);

            if (r.tokens.length < limit) {
                break;
            }

            startAfter = r.tokens[r.tokens.length - 1];
        }

        return tokens;
    }

    async getLatestMintedToken(owner?: string): Promise<string | null> {
        const targetOwner = owner || this.user.seiAddress;
        const tokens = await this.getAllTokensForOwner(targetOwner);

        if (tokens.length === 0) {
            return null;
        }

        // Sort tokens numerically to get the latest one
        const sortedTokens = tokens.sort((a, b) => {
            const numA = parseInt(a);
            const numB = parseInt(b);
            return numB - numA; // descending order
        });

        return sortedTokens[0];
    }

    async mintAndGetTokenId(receiverAddress: string, tokenIdPrefix: string = 'test'): Promise<string> {
        const timestamp = Date.now();
        const randomSuffix = Math.floor(Math.random() * 10000);
        const tokenId = `${tokenIdPrefix}_${timestamp}_${randomSuffix}`;

        await this.mintTx(tokenId, receiverAddress);
        return tokenId;
    }

    async mintMultipleAndGetTokenIds(receiverAddresses: string[], tokenIdPrefix: string = 'test'): Promise<string[]> {
        const tokenIds: string[] = [];
        const timestamp = Date.now();

        for (let i = 0; i < receiverAddresses.length; i++) {
            const randomSuffix = Math.floor(Math.random() * 10000);
            const tokenId = `${tokenIdPrefix}_${timestamp}_${i}_${randomSuffix}`;
            tokenIds.push(tokenId);
        }

        await this.mintMultiple(tokenIds, receiverAddresses);
        return tokenIds;
    }
}


export class Erc1155Token extends EvmTokenBase implements INft1155 {
    constructor(user: SeiUser, address: string) {
        super(user, new ethers.Contract(address, ERC1155_ARTIFACT.abi, user.evmWallet.wallet));
    }

    uri(tokenId: BigNumberish) { return this.contract.uri(tokenId); }
    balanceOf(account: string, tokenId: BigNumberish) { return this.contract.balanceOf(account, tokenId); }
    balanceOfBatch(accounts: string[], tokenIds: BigNumberish[]) { return this.contract.balanceOfBatch(accounts, tokenIds); }
    setApprovalForAll(operator: string, approved: boolean) { return this.contract.setApprovalForAll(operator, approved); }
    isApprovedForAll(account: string, operator: string) { return this.contract.isApprovedForAll(account, operator); }
    safeTransferFrom(from: string, to: string, tokenId: BigNumberish, amount: BigNumberish, data?: string | Uint8Array) {
        return this.contract.safeTransferFrom(from, to, tokenId, amount, data ?? "0x");
    }
    safeBatchTransferFrom(from: string, to: string, tokenIds: BigNumberish[], amounts: BigNumberish[], data?: string | Uint8Array) {
        return this.contract.safeBatchTransferFrom(from, to, tokenIds, amounts, data ?? "0x");
    }
}

export class Cw1155Token implements INft1155 {
    constructor(private user: SeiUser, private address: string, private fee: StdFee = user.seiWallet.fee) {}

    private query<T>(msg: object): Promise<T> {
        return this.user.seiWallet.cosmWasmSigningClient.queryContractSmart(this.address, msg) as Promise<T>;
    }
    private exec(msg: object, memo = ""): Promise<ExecuteResult> {
        return this.user.seiWallet.cosmWasmSigningClient.execute(
            this.user.seiAddress,
            this.address,
            msg,
            this.fee,
            memo
        );
    }

    getAddress() { return this.address};
    uri(tokenId: string) { return this.query<{ uri: string }>({ nft_info: { token_id: tokenId } }).then(r => r.uri); }
    balanceOf(account: string, tokenId: string) { return this.query<{ balance: string }>({ balance_of: { owner: account, token_id: tokenId } }).then(r => r.balance); }
    balanceOfBatch(accounts: string[], tokenIds: string[]) { return this.query<{ balances: string[] }>({ balance_of_batch: { owners: accounts, token_ids: tokenIds } }).then(r => r.balances.map(b => b)); }
    setApprovalForAll(operator: string, approved: boolean) { return this.exec({ set_approval_for_all: { operator, approved } }); }
    isApprovedForAll(account: string, operator: string) { return this.query<{ approval: boolean }>({ approval: { owner: account, operator } }).then(r => r.approval); }
    safeTransferFrom(from: string, to: string, tokenId: string, amount: string) { return this.exec({ transfer: { recipient: to, token_id: tokenId, amount } }); }
    safeBatchTransferFrom(from: string, to: string, tokenIds: string[], amounts: string[]) { return this.exec({ batch_transfer: { recipient: to, token_ids: tokenIds, amounts } }); }
    async mint(params: any): Promise<ExecuteResult> {
        const {recipient, tokenId, amount, tokenUri} = params;

        const mintMsg: any = {
            mint: {
                recipient: recipient,
                msg: {
                    token_id: tokenId,
                    amount: amount.toString(),
                },
            },
        };

        if (tokenUri) {
            mintMsg.mint.msg.token_uri = tokenUri;
        }

        try {
            const tx = await this.user.seiWallet.cosmWasmSigningClient.execute(
                this.user.seiAddress,
                this.address,
                mintMsg,
                'auto'
            );
            console.log('Mint successful:', tx.transactionHash);
            return tx;
        } catch (error: any) {
            console.error('Mint failed:', error.message);
            throw error;
        }
    }
}

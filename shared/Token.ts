import { SeiUser } from "./User";
import { ethers, Contract, BigNumberish } from "ethers";
import { DeliverTxResponse, StdFee } from "@cosmjs/stargate";
import {ExecuteResult} from "@cosmjs/cosmwasm-stargate";

import ERC20_ARTIFACT from '../artifacts/contracts/TestERC20.sol/TestERC20.json';
import ERC721_ARTIFACT from '../artifacts/contracts/TestNFT.sol/TestNFT.json';
import ERC1155_ARTIFACT from '../artifacts/contracts/TestERC1155.sol/TestERC1155.json';
import {TestERC20, TestNFT} from "../typechain-types";


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

    name() { return this.contract.name(); }
    symbol() { return this.contract.symbol(); }
    decimals() { return this.contract.decimals(); }
    totalSupply() { return this.contract.totalSupply(); }
    balanceOf(address?: string) { return this.contract.balanceOf(address ?? this.user.evmAddress); }
    transfer(to: string, amount: BigNumberish) { return this.contract.transfer(to, amount); }
    approve(spender: string, amount: BigNumberish) { return this.contract.approve(spender, amount); }
    allowance(owner: string, spender: string) { return this.contract.allowance(owner, spender); }
}


export class Cw20Token implements IFungibleToken {
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

    async name() { const res = await this.query<{ name: string }>({ name: {} }); return res.name; }
    async symbol() { const res = await this.query<{ symbol: string }>({ symbol: {} }); return res.symbol; }
    async decimals() { const res = await this.query<{ decimals: number }>({ decimals: {} }); return res.decimals; }
    async totalSupply() { const res = await this.query<{ total_supply: string }>({ total_supply: {} }); return res.total_supply; }
    async balanceOf(address?: string) { const res = await this.query<{ balance: string }>({ balance: { address: address ?? this.user.seiAddress } }); return res.balance; }
    transfer(to: string, amount: string | number) { return this.exec({ transfer: { recipient: to, amount: amount.toString() } }); }
    approve(spender: string, amount: string | number) { return this.exec({ increase_allowance: { spender, amount: amount.toString() } }); }
    allowance(owner: string, spender: string) { return this.query<{ allowance: string }>({ allowance: { owner, spender } }).then(r => r.allowance); }
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

    tokenURI(tokenId: BigNumberish): Promise<string> {
        return this.contract.tokenURI(tokenId);
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
        return this.user.seiWallet.cosmWasmSigningClient.execute(
            this.user.seiAddress,
            this.address,
            msg,
            this.fee,
            memo
        );
    }

    async name() { const r = await this.query<{ name: string }>({ name: {} }); return r.name; }
    async symbol() { const r = await this.query<{ symbol: string }>({ symbol: {} }); return r.symbol; }
    async balanceOf(owner?: string) { const r = await this.query<{ balance: string }>({ tokens: { owner: owner ?? this.user.seiAddress, start_after: null, limit: 1 } }); return r.balance; }
    async ownerOf(tokenId: string) { const r = await this.query<{ owner: string }>({ owner_of: { token_id: tokenId } }); return r.owner; }
    safeTransferFrom(from: string, to: string, tokenId: string) { return this.exec({ transfer_nft: { recipient: to, token_id: tokenId } }); }
    approve(to: string, tokenId: string) { return this.exec({ approve: { spender: to, token_id: tokenId } }); }
    getApproved(tokenId: string) { return this.query<{ approval: { spender: string } }>({ approval: { token_id: tokenId } }).then(r => r.approval.spender); }
    setApprovalForAll(operator: string, approved: boolean) { return this.exec({ approve_all: { operator, expires: null } }); }
    isApprovedForAll(owner: string, operator: string) { return this.query<{ approved: boolean }>({ approvals: { owner, operator } }).then(r => r.approved); }
    tokenUri(tokenId: string) { return this.query<{ token_uri: string }>({ nft_info: { token_id: tokenId } }).then(r => r.token_uri); }
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

    uri(tokenId: string) { return this.query<{ uri: string }>({ nft_info: { token_id: tokenId } }).then(r => r.uri); }
    balanceOf(account: string, tokenId: string) { return this.query<{ balance: string }>({ balance: { owner: account, token_id: tokenId } }).then(r => r.balance); }
    balanceOfBatch(accounts: string[], tokenIds: string[]) { return this.query<{ balances: string[] }>({ batch_balance: { owner: accounts, token_ids: tokenIds } }).then(r => r.balances.map(b => b)); }
    setApprovalForAll(operator: string, approved: boolean) { return this.exec({ set_approval_for_all: { operator, approved } }); }
    isApprovedForAll(account: string, operator: string) { return this.query<{ approval: boolean }>({ approval: { owner: account, operator } }).then(r => r.approval); }
    safeTransferFrom(from: string, to: string, tokenId: string, amount: string) { return this.exec({ transfer: { recipient: to, token_id: tokenId, amount } }); }
    safeBatchTransferFrom(from: string, to: string, tokenIds: string[], amounts: string[]) { return this.exec({ batch_transfer: { recipient: to, token_ids: tokenIds, amounts } }); }
}

import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { SeiUser } from './User';
import {
    Erc20Token,
    Erc721Token,
    Erc1155Token,
    Cw20Token,
    Cw721Token,
    Cw1155Token
} from './Token';

import ERC20_ARTIFACT from '../artifacts/contracts/TestERC20.sol/TestERC20.json';
import ERC721_ARTIFACT from '../artifacts/contracts/TestNFT.sol/TestNFT.json';
import ERC1155_ARTIFACT from '../artifacts/contracts/TestERC1155.sol/TestERC1155.json';
import DEBUG_ARTIFACT from '../artifacts/contracts/DebugContract.sol/DebugContract.json';
import {calculateFee} from "@cosmjs/stargate";
import {DebugContract} from "../typechain-types";


export class TokenDeployer {
    constructor(private user: SeiUser) {}

    async deployErc20(): Promise<Erc20Token> {
        const factory = new ethers.ContractFactory(
            ERC20_ARTIFACT.abi,
            ERC20_ARTIFACT.bytecode,
            this.user.evmWallet.wallet
        );
        const contract = await factory.deploy(this.user.evmWallet.wallet);
        await contract.waitForDeployment();
        console.log('ERC20 Contract deployed to ', contract.target);
        return new Erc20Token(this.user, contract.target as string);
    }

    async deployErc721(
        name: string,
        symbol: string,
        baseUri: string
    ): Promise<Erc721Token> {
        const ownerAddress = await this.user.evmWallet.wallet.getAddress();
        const factory = new ethers.ContractFactory(
            ERC721_ARTIFACT.abi,
            ERC721_ARTIFACT.bytecode,
            this.user.evmWallet.wallet
        );
        const contract = await factory.deploy(this.user.evmWallet.wallet);
        await contract.waitForDeployment();
        console.log('Contract deployed to ', contract.target);
                return new Erc721Token(this.user, contract.target as string);
    }


    async deployErc1155(
        uri: string
    ): Promise<Erc1155Token> {
        const factory = new ethers.ContractFactory(
            ERC1155_ARTIFACT.abi,
            ERC1155_ARTIFACT.bytecode,
            this.user.evmWallet.wallet
        );
        const contract = await factory.deploy(this.user.evmAddress);
        await contract.waitForDeployment();
        console.log('Contract deployed to ', contract.target);
        return new Erc1155Token(this.user, contract.target as string);
    }

    async deployCw20(
        wasmFilePath: string,
        initMsg: {
            name: string;
            symbol: string;
            decimals: number;
            initial_balances: { address: string; amount: string }[];
            mint?: { minter: string };
        },
        label: string
    ): Promise<Cw20Token> {
        const instantiateRes = await this.deployWasm(
            wasmFilePath,
            initMsg,
            label)
        console.log('CW20 deployed to ', instantiateRes.contractAddress);
        return new Cw20Token(this.user, instantiateRes.contractAddress);
    }

    async deployCw721(
        wasmFilePath: string,
        initMsg: { name: string; symbol: string; minter: string },
        label: string
    ): Promise<Cw721Token> {
        const instantiateRes = await this.deployWasm(
            wasmFilePath,
            initMsg,
            label)
        console.log('CW721 Contract deployed to ', instantiateRes.contractAddress);
        return new Cw721Token(this.user, instantiateRes.contractAddress);
    }


    async deployCw1155(
        wasmFilePath: string,
        initMsg: { name: string, symbol: string, minter: string; collection_info?: any },
        label: string
    ): Promise<Cw1155Token> {
        const instantiateRes = await this.deployWasm(
            wasmFilePath,
            initMsg,
            label)
        console.log('CW1155 contract deployed to ', instantiateRes.contractAddress);
        return new Cw1155Token(this.user, instantiateRes.contractAddress);
    }

    async deployWasm(wasmFilePath: string, initMsg: any, label: string) {
        const defaultUploadFee = calculateFee(10000000, '3.5usei');
        const wasm = fs.readFileSync(path.resolve(wasmFilePath));
        const uploadRes = await this.user.seiWallet.cosmWasmSigningClient.upload(
            this.user.seiAddress,
            wasm,
            defaultUploadFee
        );
        const codeId = uploadRes.codeId;
        return await this.user.seiWallet.cosmWasmSigningClient.instantiate(
            this.user.seiAddress,
            codeId,
            initMsg,
            label,
            defaultUploadFee
        );
    }

    async deployDebugContract(){
        const factory = new ethers.ContractFactory(
            DEBUG_ARTIFACT.abi,
            DEBUG_ARTIFACT.bytecode,
            this.user.evmWallet.wallet
        );
        const contract = await factory.deploy(this.user.evmWallet.wallet);
        const debugContract = await contract.waitForDeployment() as DebugContract;
        console.log('Contract deployed to ', contract.target);
        return debugContract;
    }
}

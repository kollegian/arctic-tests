import {Wallet} from "ethers";

export default class TxBuilder {
    evmUsers: Wallet[];
    constructor() {
        evmUsers = [];
    }
}

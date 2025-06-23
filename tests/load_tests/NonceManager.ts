import { ethers } from "ethers";

export class NonceManager {
    private next: Map<string, number> = new Map();

    constructor(private readonly provider: ethers.JsonRpcProvider) {}

    async take(address: string): Promise<number> {
        const addr = ethers.getAddress(address);
        if (!this.next.has(addr)) {
            const onChain = await this.provider.getTransactionCount(addr, "latest");
            this.next.set(addr, onChain);
        }
        const nonce = this.next.get(addr)!;
        this.next.set(addr, nonce + 1);
        return nonce;
    }

    peek(address: string): number | undefined {
        return this.next.get(ethers.getAddress(address));
    }
}

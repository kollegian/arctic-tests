import { SigningStargateClient } from "@cosmjs/stargate";

export class SequenceManager {
    private next = new Map<
        string,
        { accountNumber: number; sequence: number }
    >();

    constructor(private readonly client: SigningStargateClient) {}
    async take(address: string): Promise<{
        accountNumber: number;
        sequence: number;
    }> {
        if (!this.next.has(address)) {
            const acc = await this.client.getAccount(address);
            if (!acc) throw new Error(`Account ${address} not found on chain`);
            this.next.set(address, {
                accountNumber: Number(acc.accountNumber),
                sequence: Number(acc.sequence),
            });
        }

        const entry = this.next.get(address)!;
        const out   = { ...entry };
        entry.sequence += 1;
        return out;
    }
}

import { ethers } from "ethers";
import urls from "./endpoints.json";

const providers = urls.map((u) => new ethers.JsonRpcProvider(u));
const health: boolean[] = urls.map(() => true);   // optimistic start

setInterval(async () => {
    await Promise.all(
        providers.map(async (p, i) => {
            try { await p.getBlockNumber(); health[i] = true; }
            catch { health[i] = false; }
        }),
    );
}, 10_000);

export class NodeRotator {
    private idx = 0;
    pick(): ethers.JsonRpcProvider {
        for (let k = 0; k < providers.length; k++) {
            const i = (this.idx + k) % providers.length;
            if (health[i]) { this.idx = i + 1; return providers[i]; }
        }
        return providers[this.idx++ % providers.length];
    }
}

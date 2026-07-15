import { ethers } from 'ethers';

import testConfig from '../../../config/testConfig.json';

export interface MempoolNode {
    evmRpcEndpoint: string;
    seiRpcEndpoint: string;
    restEndpoint?: string;
}

/**
 * Optional `mempoolNodes` field in config/testConfig.json. If present and
 * contains >= 2 entries, broadcast/propagation tests run; otherwise they
 * skip with a clear reason.
 */
function readNodes(): MempoolNode[] {
    const raw = (testConfig as { mempoolNodes?: MempoolNode[] }).mempoolNodes;
    if (!raw || !Array.isArray(raw)) return [];
    return raw.filter(
        (n) => typeof n.evmRpcEndpoint === 'string' && typeof n.seiRpcEndpoint === 'string',
    );
}

export const MEMPOOL_NODES: MempoolNode[] = readNodes();

export function haveMultipleNodes(): boolean {
    return MEMPOOL_NODES.length >= 2;
}

export function nodeProviders(): { node: MempoolNode; provider: ethers.JsonRpcProvider }[] {
    return MEMPOOL_NODES.map((node) => ({
        node,
        provider: new ethers.JsonRpcProvider(node.evmRpcEndpoint),
    }));
}

/** Skip a `describe` block with a clear message when multi-node isn't configured. */
export function describeMultiNode(
    title: string,
    body: (this: Mocha.Suite) => void,
): void {
    if (haveMultipleNodes()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).describe(title, body);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).describe.skip(
            `${title} [skipped: set config.mempoolNodes to >=2 entries]`,
            body,
        );
    }
}

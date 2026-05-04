import {ethers, WebSocketProvider} from "ethers";
import WebSocket from 'ws';
import {expect} from "chai";

describe('Evm Rpc Tests', function () {
    this.timeout(10 * 60 * 1000);
    let provider: WebSocketProvider;
    const wsEndpoints = 'wss://evm-ws.arctic-1.seinetwork.io';
    before('Initializes', async () => {
        provider = new ethers.WebSocketProvider(wsEndpoints);
    });

    after(async () => {
        await provider.destroy();
    });

    it('should subscribe to newHeads and receive a block header', async () => {
        const ws = new WebSocket(wsEndpoints);
        const header = await new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error('Timed out waiting for newHeads subscription event'));
            }, 120_000);

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'eth_subscribe',
                    params: ['newHeads'],
                }));
            });

            ws.on('message', (data) => {
                const message = JSON.parse(data.toString());
                if (message.result && message.id === 2) {
                    expect(message.result).to.match(/^0x[0-9a-fA-F]+$/);
                    return;
                }
                if (message.method === 'eth_subscription') {
                    clearTimeout(timeout);
                    ws.close();
                    resolve(message.params.result);
                }
            });

            ws.on('error', reject);
        });

        expect(header.hash).to.match(/^0x[0-9a-fA-F]{64}$/);
        expect(header.number).to.match(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
        expect(header.parentHash).to.match(/^0x[0-9a-fA-F]{64}$/);
    });

    it('WebSocket provider can query the latest block by hash', async () => {
        const latest = await provider.getBlock('latest');
        expect(latest).to.not.eq(null);
        const byHash = await provider.getBlock(latest!.hash!);
        expect(byHash?.hash).to.eq(latest!.hash);
        expect(byHash?.number).to.eq(latest!.number);
    });

});

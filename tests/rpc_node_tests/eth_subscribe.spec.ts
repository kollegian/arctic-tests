import {ethers, WebSocketProvider} from "ethers";
import WebSocket from 'ws';

describe('@state-required Evm Rpc Tests', function () {
    this.timeout(10 * 60 * 1000);
    let expect: Chai.ExpectStatic;
    let provider: WebSocketProvider;
    const wsEndpoints = 'wss://evm-ws-testnet.sei-apis.com';
    let ws: WebSocket;
    before('Initializes', async () => {
        provider = new ethers.WebSocketProvider(wsEndpoints);
        ws = new WebSocket(wsEndpoints);
    });

    it('should subscribe to newHeads and receive a block header', async () => {

        ws.on('open', () => {
            console.log(`Connected to ${wsEndpoints}`);
            const subscriptionRequest = {
                jsonrpc: '2.0',
                id: 2,
                method: 'eth_subscribe',
                params: ['newHeads'],
            };
            ws.send(JSON.stringify(subscriptionRequest));
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                console.log('Received message:', message);
            } catch (error) {
                console.error('Error parsing message:', error);
            }
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });

        ws.on('close', () => {
            console.log('WebSocket connection closed.');
        });
    });

    it('Should subscribe to newBlockHeaders and receive a block header', async () => {
        console.log(await provider.getBlock('0x4016ef0e8e96a53e90eaf39d33c0c82719c196a561914239c78c5d8aad284898'));
    });

});

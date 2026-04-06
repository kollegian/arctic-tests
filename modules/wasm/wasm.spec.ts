import {DirectSecp256k1HdWallet} from '@cosmjs/proto-signing';
import {generateValidAddress} from '../whitelist_tests/helpers';
import {SigningCosmWasmClient} from '@cosmjs/cosmwasm-stargate';
import {createSeiWasmProvider, deployWasmContract, instantiateCode, registerName} from './utils';
import {rpcEndpoint} from './constants';
import { Querier } from '@sei-js/cosmos/rest';



describe('Wasm tests', function(){
  this.timeout(5 * 60 * 1000);
  let seiWallet: DirectSecp256k1HdWallet;
  let seiAddress: string;
  let signingWasmClient: SigningCosmWasmClient;
  let codeId: number;
  let contractAddress: string;
  let name: 'firstName';

  before('Initializes clients', async () =>{
    seiWallet = await generateValidAddress();
    seiAddress = (await seiWallet.getAccounts())[0].address;
    signingWasmClient = await createSeiWasmProvider(rpcEndpoint, seiWallet);
    codeId = await deployWasmContract(signingWasmClient, seiAddress);
    contractAddress = await instantiateCode(signingWasmClient, seiAddress, codeId);
    await registerName(signingWasmClient, seiAddress, name, contractAddress);
  });

  it('', async () =>{
    const queryDataRaw = {
      resolve_record: { name: 'first' }
    };
    const queryData = Buffer.from(JSON.stringify(queryDataRaw));

    // Query all code
    const allCode = await signingWasmClient.getCodes();
    console.log('All code: ', allCode);

    // Query specific code by ID
    const specificCode = await signingWasmClient.getCodeDetails(codeId);
    console.log('Specific code id: ', specificCode);

    // Query contracts by code ID
    const contractsByCodeId = await signingWasmClient.getContracts(codeId);
    console.log('code id contracts: ', contractsByCodeId);


    // Query contract info by address
    const contractInfo = await signingWasmClient.getContract(contractAddress);
    console.log('Contract address: ', contractInfo);

    // Query raw contract state
    const rawQuery = await signingWasmClient.queryContractRaw(contractAddress, queryData );
    console.log('Raw Query: ', rawQuery);

    // Query raw contract data with wasmClient
    //@ts-ignore
    const query = await signingWasmClient.queryContractRaw(contractAddress, rawQuery);
    console.log('Raw contract data: ', query);

    // Query smart contract state
    const smartQuery = await signingWasmClient.queryContractSmart(contractAddress, queryDataRaw);
    console.log('Smart query: ', smartQuery);

    // Query contract history
    const contractHistory = await signingWasmClient.getContractCodeHistory(contractAddress);
    console.log('History: ', contractHistory);

  })






})
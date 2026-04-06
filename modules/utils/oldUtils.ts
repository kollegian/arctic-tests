import {DirectSecp256k1HdWallet, Registry} from '@cosmjs/proto-signing';
import {BinaryWriter} from 'cosmjs-types/binary';
import {coins, SigningStargateClient} from '@cosmjs/stargate';
import {rpcEndpoint} from '../constants';
import * as util from 'node:util';
const exec = util.promisify(require('node:child_process').exec);

export async function addNewFeeder(address: string){
  const {stdout, stderror} = await exec(`seid tx oracle set-feeder ${address} --from admin --fees 24200usei -y`);
  console.log(stdout);
}

export async function aggregateVote(address: string, validatorAddress: string, seiWallet: DirectSecp256k1HdWallet) {

  const customRegistry = new Registry();
  const msgAggregateVoteTypeUrl = "/seiprotocol.seichain.oracle.MsgAggregateExchangeRateVote";

  const CustomMsgAggregateExchangeRateVote = {
    typeUrl: msgAggregateVoteTypeUrl,
    encode(message, writer = BinaryWriter.create()) {
      if (message.exchangeRates !== undefined && message.exchangeRates !== "") {
        writer.uint32(18).string(message.exchangeRates);
      }
      if (message.feeder !== undefined && message.feeder !== "") {
        writer.uint32(26).string(message.feeder);
      }
      if (message.validator !== undefined && message.validator !== "") {
        writer.uint32(34).string(message.validator);
      }
      return writer;
    },
    decode() {
      throw new Error("decode method should not be required");
    },
    fromPartial(object) {
      const message = {exchangeRates: "", feeder: "", validator: ""};
      if (object.exchangeRates !== undefined && object.exchangeRates !== null) {
        message.exchangeRates = object.exchangeRates;
      }
      if (object.feeder !== undefined && object.feeder !== null) {
        message.feeder = object.feeder;
      }
      if (object.validator !== undefined && object.validator !== null) {
        message.validator = object.validator;
      }
      return message;
    },
  };

  customRegistry.register(msgAggregateVoteTypeUrl, CustomMsgAggregateExchangeRateVote);


  const msg = {
    exchangeRates: "102.5usei,0.3uatom",
    feeder: address,
    validator: validatorAddress
  };

  const msgAny = {
    typeUrl: msgAggregateVoteTypeUrl,
    value: msg,
  };

  const fee = {
    amount: coins(24000, "usei"),
    gas: "250000",
  };

  const memo = "Aggregate Exchange Rate Vote";

  const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet, {registry: customRegistry});

  const result = await client.signAndBroadcast(address, [msgAny], fee, memo);
}
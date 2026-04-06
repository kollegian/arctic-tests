import {DirectSecp256k1HdWallet, Registry} from '@cosmjs/proto-signing';
import {BinaryWriter, Coin} from '@sei-js/proto';
import {coins} from '@cosmjs/amino';
import {SigningStargateClient} from '@cosmjs/stargate';
import {getAddress, rpcEndpoint} from './helpers';
import {ethers} from 'ethers';

export const fee = {
  amount: coins(24000, "usei"),
  gas: "500000",
};

export type Wallets = {
  creatorWallet: DirectSecp256k1HdWallet;
  whitelistedWallet: DirectSecp256k1HdWallet;
  unwhitelistedWallet: DirectSecp256k1HdWallet;
  tobeWhitelistedWallet: DirectSecp256k1HdWallet;
  newAdminWallet: DirectSecp256k1HdWallet;
  toBeRemovedUser: DirectSecp256k1HdWallet;
};

export async function createNewDenom(senderAddress: string, subdenom: string, signerWallet: DirectSecp256k1HdWallet, whitelistItems?: string[]) {
  const customRegistry = new Registry();
  const msgCreateDenomTypeUrl = "/seiprotocol.seichain.tokenfactory.MsgCreateDenom";

  const encodeAllowList = (allowList, writer) => {
    if (allowList.addresses !== undefined && allowList.addresses.length > 0) {
      for (const address of allowList.addresses) {
        writer.uint32(10).string(address); // Adjust as per proto tag number for repeated strings
      }
    }
    return writer;
  };

  const CustomMsgCreateDenom = {
    typeUrl: msgCreateDenomTypeUrl,
    encode(message, writer = BinaryWriter.create()) {
      if (message.sender !== undefined && message.sender !== "") {
        writer.uint32(10).string(message.sender);
      }
      if (message.subdenom !== undefined && message.subdenom !== "") {
        writer.uint32(18).string(message.subdenom);
      }
      if (message.allowList !== undefined && message.allowList !== null) {
        writer.uint32(26).fork(); // Start of field 3 for allowList
        encodeAllowList(message.allowList, writer).ldelim(); // Encode each address in allowList
      }
      return writer;
    },
    decode() {
      throw new Error("decode method should not be required");
    },
    fromPartial(object) {
      const message = { sender: "", subdenom: "", allowList: { addresses: [] }  };
      if (object.sender !== undefined && object.sender !== null) {
        message.sender = object.sender;
      }
      if (object.subdenom !== undefined && object.subdenom !== null) {
        message.subdenom = object.subdenom;
      }
      if (object.allowList !== undefined && object.allowList.addresses !== null) {
        message.allowList.addresses = object.allowList.addresses;
      }
      return message;
    },
  };

// @ts-ignore
  customRegistry.register(msgCreateDenomTypeUrl, CustomMsgCreateDenom);
  let msg;
  if (!whitelistItems) {
    msg = {
      sender: senderAddress,
      subdenom: subdenom,
    }
  } else {
    msg = {
      sender: senderAddress,
      subdenom: subdenom,
      allowList: {addresses: whitelistItems},
    };
  }

  const msgAny = {
    typeUrl: msgCreateDenomTypeUrl,
    value: msg,
  };

  const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, signerWallet, { registry: customRegistry });

  return await client.signAndBroadcast(senderAddress, [msgAny], fee, "");
}

export async function updateDenomMessage(subdenom: string, signerWallet: DirectSecp256k1HdWallet, allowList: (string | ethers.HDNodeWallet)[] | ethers.HDNodeWallet[]) {
  const customRegistry = new Registry();
  const msgUpdateDenomTypeUrl = "/seiprotocol.seichain.tokenfactory.MsgUpdateDenom";

  const encodeAllowList = (allowList, writer) => {
    if (allowList.addresses !== undefined && allowList.addresses.length > 0) {
      for (const address of allowList.addresses) {
        writer.uint32(10).string(address); // Adjust as per proto tag number for repeated strings
      }
    }
    return writer;
  };

  const CustomMsgUpdateDenom = {
    typeUrl: msgUpdateDenomTypeUrl,
    encode(message, writer = BinaryWriter.create()) {
      if (message.sender !== undefined && message.sender !== "") {
        writer.uint32(10).string(message.sender); // Field 1
      }
      if (message.subdenom !== undefined && message.subdenom !== "") {
        writer.uint32(18).string(message.subdenom); // Field 2
      }
      if (message.allowList !== undefined && message.allowList !== null) {
        writer.uint32(26).fork(); // Start of field 3 for allowList
        encodeAllowList(message.allowList, writer).ldelim(); // Encode each address in allowList
      }
      return writer;
    },
    decode() {
      throw new Error("decode method should not be required");
    },
    fromPartial(object) {
      const message = { sender: "", subdenom: "", allowList: { addresses: [] } };
      if (object.sender !== undefined && object.sender !== null) {
        message.sender = object.sender;
      }
      if (object.subdenom !== undefined && object.subdenom !== null) {
        message.subdenom = object.subdenom;
      }
      if (object.allowList !== undefined && object.allowList.addresses !== null) {
        message.allowList.addresses = object.allowList.addresses;
      }
      return message;
    },
  };

// @ts-ignore
  customRegistry.register(msgUpdateDenomTypeUrl, CustomMsgUpdateDenom);

// Example usage
  const address = (await signerWallet.getAccounts())[0].address;
  const allowJs = {
    addresses: allowList // Ensure this is an array of valid addresses
  };

  const msg = {
    sender: address,
    subdenom: subdenom,
    allowList: allowJs,
  };

  const msgAny = {
    typeUrl: msgUpdateDenomTypeUrl,
    value: msg,
  };

  const fee = {
    amount: coins(200000, "usei"),
    gas: "6000000",
  };
  const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, signerWallet, { registry: customRegistry });
  return await client.signAndBroadcast(address, [msgAny], fee, "");
}

export async function mintTokens(subdenom: string, signerWallet: DirectSecp256k1HdWallet) {
  const customRegistry = new Registry();
  const msgMintTypeUrl = "/seiprotocol.seichain.tokenfactory.MsgMint";

  const encodeCoin = (coin, writer) => {
    if (coin.denom !== undefined && coin.denom !== "") {
      writer.uint32(10).string(coin.denom); // Field 1 (denom)
    }
    if (coin.amount !== undefined && coin.amount !== "") {
      writer.uint32(18).string(coin.amount); // Field 2 (amount)
    }
    return writer;
  };

  const CustomMsgMint = {
    typeUrl: msgMintTypeUrl,
    encode(message, writer = BinaryWriter.create()) {
      if (message.sender !== undefined && message.sender !== "") {
        writer.uint32(10).string(message.sender); // Field 1 (sender)
      }
      if (message.amount !== undefined && message.amount !== null) {
        writer.uint32(18).fork(); // Field 2 (amount)
        encodeCoin(message.amount, writer).ldelim(); // Encode amount as Coin object
      }
      return writer;
    },
    decode() {
      throw new Error("decode method should not be required");
    },
    fromPartial(object) {
      const message = { sender: "", amount: { denom: "", amount: "" } };
      if (object.sender !== undefined && object.sender !== null) {
        message.sender = object.sender;
      }
      if (object.amount !== undefined && object.amount !== null) {
        message.amount = object.amount;
      }
      return message;
    },
  };

// @ts-ignore
  customRegistry.register(msgMintTypeUrl, CustomMsgMint);

  const address = (await signerWallet.getAccounts())[0].address;

  const msg = {
    sender: address,
    amount: {
      denom: subdenom,
      amount: "10000000",
    },
  };
  const msgAny = {
    typeUrl: msgMintTypeUrl,
    value: msg,
  };
  const memo = "Mint Tokens";
  const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, signerWallet, { registry: customRegistry });

  return await client.signAndBroadcast(address, [msgAny], fee, memo);
}

export async function bankTransfer(senderWallet: DirectSecp256k1HdWallet, denom: string, amount: number, receiverWallet: string) {
  const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, senderWallet);
  const senderAddress = await getAddress(senderWallet);
  const sendCoin: Coin = {
    denom,
    amount: `${amount}`
  }
  return await client.sendTokens(senderAddress, receiverWallet, [sendCoin], fee);
}

export async function burnTokens(signerWallet: DirectSecp256k1HdWallet, denom: string, amount: number) {
  const customRegistry = new Registry();
  const msgBurnTypeUrl = "/seiprotocol.seichain.tokenfactory.MsgBurn";

  const CustomMsgBurn = {
    typeUrl: msgBurnTypeUrl,
    encode(message, writer = BinaryWriter.create()) {
      if (message.sender !== undefined && message.sender !== "") {
        writer.uint32(10).string(message.sender); // Field number 1 for sender
      }
      if (message.amount !== undefined && message.amount !== null) {
        writer.uint32(18).fork();
        writer.uint32(10).string(message.amount.denom);
        writer.uint32(18).string(message.amount.amount);
        writer.ldelim();
      }
      return writer;
    },
    decode() {
      throw new Error("decode method should not be required");
    },
    fromPartial(object) {
      const message = { sender: "", amount: { denom: "", amount: "" } };
      if (object.sender !== undefined && object.sender !== null) {
        message.sender = object.sender;
      }
      if (object.amount !== undefined && object.amount !== null) {
        message.amount = object.amount;
      }
      return message;
    },
  };

// @ts-ignore
  customRegistry.register(msgBurnTypeUrl, CustomMsgBurn);

  const address = (await signerWallet.getAccounts())[0].address;

  const msg = {
    sender: address,
    amount: {
      denom,
      amount: `${amount}`,
    },
  };

  const msgAny = {
    typeUrl: msgBurnTypeUrl,
    value: msg,
  };
  const memo = "Burn token";
  const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, signerWallet, { registry: customRegistry });
  return await client.signAndBroadcast(address, [msgAny], fee, memo);
}

export async function setAdmin(senderWallet: DirectSecp256k1HdWallet, newAdmin: DirectSecp256k1HdWallet, fullDenom: string){
  const customRegistry = new Registry();
  const msgSetAdminTypeUrl = "/seiprotocol.seichain.tokenfactory.MsgChangeAdmin";

  const CustomMsgSetAdmin = {
    typeUrl: msgSetAdminTypeUrl,

    encode(message, writer = BinaryWriter.create()) {
      writer.uint32(10).string(message.sender || "");
      writer.uint32(18).string(message.denom || "");
      writer.uint32(26).string(message.newAdmin || "");

      return writer;
    },

    fromPartial(object) {
      return {
        sender: object.sender || "",
        denom: object.denom || "",
        newAdmin: object.newAdmin || ""
      };
    }
  };

  //@ts-ignore
  customRegistry.register(msgSetAdminTypeUrl, CustomMsgSetAdmin);

  const address = await getAddress(senderWallet);
  const newAdminAddress = await getAddress(newAdmin);
  const msgSetAdmin = {
    sender: address,
    denom: fullDenom,
    newAdmin: newAdminAddress
  };

  const msgAny = {
    typeUrl: msgSetAdminTypeUrl,
    value: msgSetAdmin,
  };

  const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, senderWallet, { registry: customRegistry });
  return await client.signAndBroadcast(address, [msgAny], fee, "");
}
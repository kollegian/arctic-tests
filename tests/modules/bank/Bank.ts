import { coins } from '@cosmjs/stargate';
import { ethers } from 'ethers';
import { MsgCreateVestingAccount } from 'cosmjs-types/cosmos/vesting/v1beta1/tx';

export class BankSei {
  coinSendMessage(senderAddress: string, receiverAddress: string, amountCoin: string, denom: string) {
    const msg = {
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: senderAddress,
        toAddress: receiverAddress,
        amount: coins(amountCoin, denom),
      },
    };
    return [msg];
  }

  createVestingMessage(
    senderAddress: string,
    recipientAddress: string,
    amount: string,
    denom: string,
    vestingDurationSeconds: number
  ) {
    const currentTime = Math.floor(Date.now() / 1000);
    const endTime = currentTime + vestingDurationSeconds;

    const msgValue = MsgCreateVestingAccount.fromPartial({
      fromAddress: senderAddress,
      toAddress: recipientAddress,
      amount: coins(amount, denom),
      endTime: BigInt(endTime),
      delayed: true,
    });
    return {
      typeUrl: `/cosmos.vesting.v1beta1.MsgCreateVestingAccount`,
      value: msgValue,
    };
  }

  coinMultiSendMessage(
    inputs: { address: string; amount: { amount: string; denom: string }[] }[],
    outputs: { address: string; amount: { amount: string; denom: string }[] }[]
  ) {
    const msg = {
      typeUrl: '/cosmos.bank.v1beta1.MsgMultiSend',
      value: {
        inputs: inputs.map((input) => ({
          address: input.address,
          coins: input.amount.map((coin) => coins(coin.amount, coin.denom)[0]),
        })),
        outputs: outputs.map((output) => ({
          address: output.address,
          coins: output.amount.map((coin) => coins(coin.amount, coin.denom)[0]),
        })),
      },
    };

    return [msg];
  }

}

export class BankEvm {
  coinSendMessage(to: string, senderAddress: string, amount: string) {
    return {
      to,
      from: senderAddress,
      value: ethers.parseUnits(amount.toString(), 'ether'),
    };
  }
}

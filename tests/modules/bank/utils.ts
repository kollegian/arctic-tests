import {Coin} from '@cosmjs/proto-signing';
import BigNumber from 'bignumber.js';


export async function returnExpect(){
  const chai = await import('chai');
  const { expect } = chai;
  return expect;
}

export function getPaidGasFee(inputBalance: Coin, outputBalance:Coin, transferAmount: string){
  const gasFee = (new BigNumber(inputBalance.amount).minus(new BigNumber(outputBalance.amount))).minus(new BigNumber(transferAmount));
  return Number(gasFee);
}
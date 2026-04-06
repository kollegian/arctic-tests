import {restEndpoint} from '../constants';

export async function queryAllowlist(fullDenom: string) {
  const url = `${restEndpoint}/sei-protocol/seichain/tokenfactory/denoms/allow_list?denom=${fullDenom}`;
  const response = await fetch(url);
  return await response.json();
}
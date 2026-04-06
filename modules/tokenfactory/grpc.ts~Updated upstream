export async function queryAllowlist(fullDenom: string) {
  const url = `http://127.0.0.1:1317/sei-protocol/seichain/tokenfactory/denoms/allow_list?denom=${fullDenom}`;
  const response = await fetch(url);
  return await response.json();
}
import {gql, request} from 'graphql-request';
import {GOLDSKY_QUERY_URL} from './constants';

export class GoldSkyClient {
  url: string;

  constructor() {
    this.url = GOLDSKY_QUERY_URL;
  }

  async queryTransfers(targetBlockNumber: number, endBlockNumber: number){
    console.log('Querying Data from goldsky')
    const graphQlQuery = gql`{
      transfers(
        first: 5,
        where: {
          block_number_gte: ${endBlockNumber},
          block_number_lte: ${targetBlockNumber}
        }
        orderBy: block_number,
        orderDirection: desc
      ) {
        id
        from
        to
        value
        block_number
        transactionHash_
        timestamp_
      }
    }`
    return await request(this.url, graphQlQuery, {}, {});
  }

}
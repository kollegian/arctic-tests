import {GRAPH_API_KEY, GRAPH_QUERY_URL} from './constants';
import { gql, request } from 'graphql-request'

export class GraphClient {
  apiKey: string;
  url: string;
  constructor() {
    this.apiKey = GRAPH_API_KEY;
    this.url = GRAPH_QUERY_URL;
  }

  async queryTransfers(targetBlockNumber: number, endBlockNumber: number){
    console.log('Querying Data from graph')
    const graphQlQuery = gql`{
      transfers(
        first: 5,
        where: {
          blockNumber_gte: ${endBlockNumber},
          blockNumber_lte: ${targetBlockNumber} 
        }
        orderBy: blockNumber,
        orderDirection: desc
      ) {
        id
        from
        to
        value
        blockNumber
        transactionHash
        blockTimestamp
      }
    }`

    const headers = { Authorization: `Bearer ${this.apiKey}` }
    return await request(this.url, graphQlQuery, {}, headers)
  }
}

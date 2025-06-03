import {gql, request} from 'graphql-request';
import {GOLDSKY_QUERY_URL} from './constants';

export class GoldSkyClient {
    url: string;

    constructor() {
        this.url = GOLDSKY_QUERY_URL;
    }

    async queryTransfers(targetBlockNumber: number, endBlockNumber: number) {
        console.log('Querying Data from goldsky');
        const twentyMinutesAgo = Math.floor((Date.now() - 20 * 60 * 1000) / 1000); // in seconds
        const graphQlQuery = gql`{
          transfers(
            first: 5,
            where: {
              timestamp__lte: ${twentyMinutesAgo}
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

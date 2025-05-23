import { DuneClient, QueryParameter } from "@duneanalytics/client-sdk";
import {DUNE_API_KEY, DUNE_BLOCK_QUERY} from './constants';

export class DuneLocalClient {
  client: DuneClient;

  constructor() {
    this.client = new DuneClient(DUNE_API_KEY)
  }

  async fetchLatestBlockDetails(blockHeight: number){
    console.log('Querying Data from dune')
    const { result } = await this.client.runQuery({
      queryId: DUNE_BLOCK_QUERY,
    });

    return result?.rows;
  }

}

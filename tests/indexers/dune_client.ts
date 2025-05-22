import { DuneClient, QueryParameter } from "@duneanalytics/client-sdk";
import {DUNE_API_KEY, DUNE_BLOCK_QUERY} from './constants';

export class DuneLocalClient {
  client: DuneClient;

  constructor() {
    this.client = new DuneClient(DUNE_API_KEY)
  }

  async fetchLatestBlockDetails(blockHeight: number){
    // kick off the query
    /*const execRes = await this.client.getLatestResult({queryId: 5171960});
    // wait for it to finish and pull the rows
    console.log(execRes);*/

    const query_parameters = [
      QueryParameter.number("Height", blockHeight),
    ];

    // pass everything as one object
    const { result } = await this.client.runQuery({
      queryId: DUNE_BLOCK_QUERY,
    });

    console.log(result?.rows);
    return result?.rows;
  }

}

import {DuneLocalClient} from './dune_client';

describe('Indexer Tests', function () {
  this.timeout(10 * 60 * 1000);
  const duneClient = new DuneLocalClient();

  it('Can query latest block data', async () => {
    const blockData = await duneClient.fetchLatestBlockDetails(148504793);
  })
});
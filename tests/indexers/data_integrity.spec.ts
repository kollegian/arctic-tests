import {DuneLocalClient} from './dune_client';
import {GraphClient} from './graph_client';
import {GoldSkyClient} from './goldsky_client';
import {expect} from 'chai';

describe('Indexer Tests', function () {
  this.timeout(10 * 60 * 1000);
  const duneClient = new DuneLocalClient();
  const graphClient = new GraphClient();
  const goldSkyClient = new GoldSkyClient();

  let duneData: Record<string, any>[];
  let targetBlockNumber: number;
  let endBlockNumber: number;

  it('Queries dune data to set target block and check latest transfer date', async () => {
    duneData = await duneClient.fetchLatestBlockDetails(148504793) as Record<string, any>[];
    const duneTimeDiffs = duneData.map(block => getTimeDifferenceFromNow(block.block_time));
    targetBlockNumber = duneData[0].block_number - 5000;
    endBlockNumber = targetBlockNumber - 2000;
    duneTimeDiffs.map(results => expect(results.isEarlierThan2Hours).to.be.false);
  });

  it('Queries graph and goldsky data with given blocks and expects complete equality', async () => {
    const graphData = await graphClient.queryTransfers(targetBlockNumber, endBlockNumber) as graphData;
    const graphTimeDiffs = graphData.transfers.map(block => getTimeDifferenceFromNow(Number(block.blockTimestamp)));
    const goldSkyData = await goldSkyClient.queryTransfers(targetBlockNumber, endBlockNumber) as graphData;
    const goldSkyTimeDiffs = goldSkyData.transfers.map(block => getTimeDifferenceFromNow(Number(block.timestamp_)));
    console.log(graphData);
    console.log('---------');
    console.log(goldSkyData);
    expect(graphData.transfers.length).to.be.eq(goldSkyData.transfers.length);

    //Removing the duplicate entries completely
    const txHashCounts = graphData.transfers.reduce((counts, transfer) => {
      const hash = transfer.transactionHash;
      counts[hash] = (counts[hash] || 0) + 1;
      return counts;
    }, {});

    const uniqueTransfers = graphData.transfers.filter(transfer =>
      txHashCounts[transfer.transactionHash] === 1
    );

    uniqueTransfers.forEach((transferData) => {
      const goldskyData = goldSkyData.transfers.find(t => t.transactionHash_ === transferData.transactionHash);
      if (!goldskyData) throw new Error('Didnt return the same data');

      expect(transferData.from).to.be.eq(goldskyData.from);
      expect(transferData.to).to.be.eq(goldskyData.to);
      expect(transferData.blockNumber).to.be.eq(goldskyData.block_number);
      expect(transferData.value).to.be.eq(goldskyData.value);
    });

  })
});


function getTimeDifferenceFromNow(timeValue: string | number): {
  difference: string;
  isEarlierThan2Hours: boolean;
} {
  let targetDate: Date;
  if (typeof timeValue === 'number') {
    targetDate = new Date(timeValue * 1000);
  } else {
    const formattedTimeValue = timeValue.replace(' UTC', '+00:00');
    targetDate = new Date(formattedTimeValue);
  }

  const now = new Date();
  const diffMs = targetDate.getTime() - now.getTime();
  const diffMinutes = Math.abs(diffMs) / (1000 * 60);
  const diffHours = diffMinutes / 60;
  const direction = diffMs >= 0 ? 'from now' : 'ago';
  const isEarlierThan2Hours = diffHours >= 2;

  return {
    difference: `${Math.floor(diffHours)} hours and ${Math.floor(diffMinutes % 60)} minutes ${direction}`,
    isEarlierThan2Hours
  };
}

type graphData = {
  transfers: any[]
}
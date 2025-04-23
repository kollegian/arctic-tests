// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract Picasso is Initializable, OwnableUpgradeable {
    struct Market {
        mapping(address => uint256[]) predictions;
        address[] participants;                // Used for iteration in calculateWinner
        mapping(address => uint256) leaderboard;
        uint256 lastCalculatedEpoch;
        bool isFinalized;
        string ticker;
        uint256 totalFunds;
    }

    struct LeaderboardResponse {
        address user;
        uint256 score;
    }

    mapping(uint32 => Market) private markets; // Markets mapped by date (YYYYMMDD)
    uint256 public maxEntries;
    uint8 public numPredictions;
    uint256 public constant LEADERBOARD_PERCENTAGE = 10;

    event MarketCreated(uint32 date);
    event PredictionSubmitted(uint32 date, address user, uint256[] predictions);
    event PredictionSubmittedByOwner(uint32 date, address user, uint256[] predictions);
    event ScoresAccumulated(uint32 date, uint256 epoch);
    event MarketFinalized(uint32 date);
    event MaxEntriesUpdated(uint256 newMaxEntries);
    event NumPredictionsUpdated(uint8 newNumPredictions);

    function initialize(uint256 _maxEntries, uint8 _numPredictions) public initializer {
        __Ownable_init(msg.sender);
        maxEntries = _maxEntries;
        numPredictions = _numPredictions;
    }

    // MARK: Modifiers
    modifier validDate(uint32 date) {
        uint256 year = date / 10000;
        uint256 month = (date / 100) % 100;
        uint256 day = date % 100;

        require(year > 2024 && year < 2100, "Year must be between 2025 and 2099");
        require(month >= 1 && month <= 12, "Month must be between 1 and 12");

        if (month == 2) {
            uint256 maxDays = (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28;
            require(day >= 1 && day <= maxDays, "Invalid day for February");
        } else if (month == 4 || month == 6 || month == 9 || month == 11) {
            require(day >= 1 && day <= 30, "Invalid day for this month");
        } else {
            require(day >= 1 && day <= 31, "Invalid day for this month");
        }
        _;
    }

    modifier marketExists(uint32 date) {
        require(bytes(markets[date].ticker).length > 0, "Market does not exist for this date.");
        _;
    }

    modifier onlyUniqueParticipant(uint32 date) {
        Market storage market = markets[date];
        require(market.predictions[msg.sender].length == 0, "Duplicate prediction for this market by user.");
        _;
    }

    modifier belowMaxEntries(uint32 date) {
        require(markets[date].participants.length < maxEntries, "Market has reached max entries.");
        _;
    }

    // MARK: ADMIN FUNCTIONS
    function setMaxEntries(uint256 newMaxEntries) external onlyOwner {
        require(newMaxEntries > 0, "Max entries must be greater than zero.");
        maxEntries = newMaxEntries;
        emit MaxEntriesUpdated(newMaxEntries);
    }

    function setNumPredictions(uint8 newNumPredictions) external onlyOwner {
        require(newNumPredictions > 0, "Number of predictions must be greater than zero");
        numPredictions = newNumPredictions;
        emit NumPredictionsUpdated(newNumPredictions);
    }

    function createMarket(uint32 date, string calldata ticker) external onlyOwner validDate(date) {
        require(bytes(ticker).length > 0, "Ticker must not be empty");

        Market storage market = markets[date];
        market.ticker = ticker;

        emit MarketCreated(date);
    }

    // MARK: PUBLIC FUNCTIONS
    function submitPrediction(uint32 date, uint256[] calldata predictions) external payable validDate(date) marketExists(date) onlyUniqueParticipant(date) belowMaxEntries(date) {
        require(msg.value == 2 ether, "You must send exactly 2 SEI to submit a prediction");

        Market storage market = markets[date];

        require(market.predictions[msg.sender].length == 0, "Predictions already submitted");
        require(predictions.length == numPredictions, string(abi.encodePacked("Invalid prediction length; expected ", Strings.toString(numPredictions))));

        market.predictions[msg.sender] = predictions;
        market.participants.push(msg.sender);

        market.totalFunds += msg.value;

        emit PredictionSubmitted(date, msg.sender, predictions);
    }

    function submitPredictionByOwner(uint32 date, address user, uint256[] calldata predictions) external onlyOwner validDate(date) marketExists(date) belowMaxEntries(date) {
        require(predictions.length == numPredictions, string(abi.encodePacked("Invalid prediction length; expected ", Strings.toString(numPredictions))));

        Market storage market = markets[date];

        // Add user to participants if they are not already in the list
        if (market.predictions[user].length == 0) {
            market.participants.push(user);
        }

        // Overwrite or add the prediction
        market.predictions[user] = predictions;

        emit PredictionSubmittedByOwner(date, user, predictions);
    }

    function accumulateScore(uint32 date, uint8 epoch, bool throwerror) external onlyOwner validDate(date) {
        Market storage market = markets[date];
        require(!market.isFinalized, "Market has already been finalized.");
        require(epoch > market.lastCalculatedEpoch, "Epoch already calculated or invalid");
        require(epoch <= numPredictions, "Epoch exceeds number of predictions");

        // Retrieve dummy prices from the mocked Pyth function.
        uint256[] memory pythPrices = getPricesFromPyth(date, epoch, market.ticker, throwerror);

        for (uint256 i = 0; i < market.participants.length; i++) {
            address user = market.participants[i];
            uint256 currentScore = market.leaderboard[user];
            uint256[] memory predictions = market.predictions[user];

            for (uint256 j = market.lastCalculatedEpoch; j < epoch; j++) {
                currentScore += absDifference(predictions[j], pythPrices[j]);
            }

            market.leaderboard[user] = currentScore;
        }

        market.lastCalculatedEpoch = epoch;

        emit ScoresAccumulated(date, epoch);
    }

    function finalizeMarket(uint32 date) external validDate(date) marketExists(date) {
        Market storage market = markets[date];
        require(market.lastCalculatedEpoch == numPredictions, "Not all epochs have been calculated");

        address[] memory sortedLeaderboard = sortLeaderboard(market.leaderboard, market.participants);

        payWinners(date, sortedLeaderboard, market.participants.length);

        market.isFinalized = true;
        market.totalFunds = 0;

        emit MarketFinalized(date);
    }

    // MARK: Helper functions

    /// @notice Dummy implementation to simulate retrieving price points from Pyth.
    /// @dev Returns an array of dummy price points with each price being (index + 1) * 1000.
    function getPricesFromPyth(
        uint32 /*date*/,
        uint8 epoch,
        string memory /*ticker*/,
        bool throwError
    )
    internal
    pure
    returns (uint256[] memory)
    {
        if (throwError) {
            revert("Error triggered as requested");
        }

        uint256[] memory prices = new uint256[](epoch);
        for (uint8 i = 0; i < epoch; i++) {
            prices[i] = (i + 1) * 1000;
        }
        return prices;
    }

    function absDifference(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function sortLeaderboard(mapping(address => uint256) storage leaderboard, address[] storage participants) internal view returns (address[] memory){
        uint256 length = participants.length;
        address[] memory sortedParticipants = new address[](length);
        uint256[] memory scores = new uint256[](length);

        // Populate temporary arrays
        for (uint256 i = 0; i < length; i++) {
            sortedParticipants[i] = participants[i];
            scores[i] = leaderboard[participants[i]];
        }

        // Perform a simple bubble sort (can be replaced with more efficient sorts)
        for (uint256 i = 0; i < length; i++) {
            for (uint256 j = 0; j < length - 1; j++) {
                if (scores[j] > scores[j + 1]) {
                    // Swap scores
                    (scores[j], scores[j + 1]) = (scores[j + 1], scores[j]);

                    // Swap participants
                    (sortedParticipants[j], sortedParticipants[j + 1]) = (
                        sortedParticipants[j + 1],
                        sortedParticipants[j]
                    );
                }
            }
        }

        return sortedParticipants;
    }

    function payWinners(uint32 date, address[] memory sortedLeaderboard, uint256 participantCount) internal {
        require(participantCount > 0, "No participants to distribute rewards");

        Market storage market = markets[date];
        uint256 totalFunds = market.totalFunds;
        require(totalFunds > 0, "No funds available for distribution");

        // Calculate distribution amounts
        uint256 winnerReward = (totalFunds * 80) / 100; // 80% to the winner
        uint256 ownerReward = (totalFunds * 10) / 100;  // 10% to the contract owner
        uint256 refundPool = (totalFunds * 10) / 100;   // 10% to top 10%

        // Transfer rewards
        address winner = sortedLeaderboard[0];
        payable(winner).transfer(winnerReward);

        // Transfer owner's share
        payable(owner()).transfer(ownerReward);

        // Refund the top 10% (excluding the winner)
        uint256 refundCount = (participantCount * LEADERBOARD_PERCENTAGE) / 100;
        uint256 refundAmount = refundPool / refundCount;

        for (uint256 i = 1; i <= refundCount; i++) {
            address participant = sortedLeaderboard[i];
            payable(participant).transfer(refundAmount);
        }
    }

    // MARK: Views
    function getParticipants(uint32 date) external view marketExists(date) returns (address[] memory) {
        return markets[date].participants;
    }

    function getUserPrediction(uint32 date, address user) external view marketExists(date) returns (uint256[] memory) {
        return markets[date].predictions[user];
    }

    function getTicker(uint32 date) external view marketExists(date) returns (string memory) {
        return markets[date].ticker;
    }

    function getLeaderboard(uint32 date, uint8 page, uint8 limit) external view marketExists(date) returns (LeaderboardResponse[] memory){
        require(limit > 0, "Limit must be greater than zero");
        require(limit <= 50, "Limit exceeds maximum pagination size");

        uint256 totalParticipants = markets[date].participants.length;
        require(page * limit < totalParticipants, "Invalid page or limit");

        uint256 start = page * limit;
        uint256 end = start + limit > totalParticipants ? totalParticipants : start + limit;
        LeaderboardResponse[] memory responses = new LeaderboardResponse[](end - start);

        for (uint256 i = start; i < end; i++) {
            address user = markets[date].participants[i];
            responses[i - start] = LeaderboardResponse(user, markets[date].leaderboard[user]);
        }

        return responses;
    }
}

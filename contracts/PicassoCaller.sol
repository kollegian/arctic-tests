import "./IPicasso.sol";

contract PicassoCaller {
    address public owner;
    IPicasso public picassoContract;

    event Received(address from, uint256 amount);
    /// @notice The contract is initialized with the address of the deployed Picasso contract.
    constructor(address _picassoAddress) {
        owner = msg.sender;
        picassoContract = IPicasso(_picassoAddress);
    }

    /// @notice Allows the owner to deposit funds into this contract.
    /// Only deposits via this function will be accepted.
    function deposit() external payable {
        require(msg.sender == owner, "Only owner can deposit");
        // Funds deposited here will be used to forward 2 ether with the call.
    }

    /// @notice Accepts incoming Ether transfers.
    /// This allows reward payments or any other Ether sent to the contract.
    receive() external payable {
        emit Received(msg.sender, msg.value);
    }

    /// @notice Fallback function to also accept calls with data.
    fallback() external payable {
        emit Received(msg.sender, msg.value);
    }


    /// @notice Reject any direct Ether transfers.
//    receive() external payable {
//        revert("Direct deposits not allowed");
//    }
//
//    /// @notice Reject any calls with data that do not match a function signature.
//    fallback() external payable {
//        revert("Direct deposits not allowed");
//    }

    /// @notice Calls the Picasso contract's submitPrediction function.
    /// This function forwards exactly 2 ether, which must be available in this contract.
    /// @param date The market date (in YYYYMMDD format) for which the prediction is submitted.
    /// @param predictions The array of predictions.
    function submitPredictionToPicasso(
        uint32 date,
        uint256[] calldata predictions
    ) external {
        require(msg.sender == owner, "Only owner can submit prediction");
        require(address(this).balance >= 2 ether, "Insufficient balance to submit prediction");

        // Forward exactly 2 ether to Picasso's submitPrediction function.
        picassoContract.submitPrediction{value: 2 ether}(date, predictions);
    }

    /// @notice (Optional) Allow the owner to withdraw any funds from the contract.
    /// This might be useful for recovering any stuck funds.
    /// @param amount The amount of Ether to withdraw.
    function withdraw(uint256 amount) external {
        require(msg.sender == owner, "Only owner can withdraw");
        payable(owner).transfer(amount);
    }
}
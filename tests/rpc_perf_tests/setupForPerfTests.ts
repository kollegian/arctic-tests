import {UserFactory} from "../../shared/User";
import {ethers} from "ethers";
import DisperseAbi from "../../artifacts/contracts/disperseEther.sol/EtherDisperser.json";
import {EtherDisperser} from "../../typechain-types";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {waitFor} from "../../shared/utils/helpers";
import fs from 'fs';
import path from 'path';
import { spawn } from "node:child_process";
import { once }  from "node:events";


const main = async () => {
    console.log('🚀 Setting up performance tests with disperse contract...');

    // first create wallet
    const admin = await UserFactory.createAdminUser();
    await UserFactory.fundAdminOnSei();
    console.log('✅ Admin user created and funded');

    const contract = new ethers.ContractFactory(DisperseAbi.abi, DisperseAbi.bytecode, admin.evmWallet.wallet);
    const contractInstance = (await contract.deploy()) as unknown as EtherDisperser;
    await contractInstance.waitForDeployment();
    console.log(`✅ Disperse contract deployed at: ${contractInstance.target}`);

    const addresses = [];
    const amounts = [];
    for (let i = 0; i < 5000; i++) {
        addresses.push(ethers.Wallet.createRandom(admin.evmWallet.signingClient).address);
        amounts.push(ethers.parseEther('0.1'));
    }

    const baseNonce = await admin.evmWallet.wallet.getNonce('latest');
    const chainId = (await admin.evmWallet.signingClient.getNetwork()).chainId;
    const signedTxs: string[] = [];

    console.log('📤 Preparing 50 transactions...');
    for (let i = 0; i < 50; i++) {
        const addressToSend = addresses.splice(0, 100);
        const amountToSend = amounts.splice(0, 100);
        const data = contractInstance.interface.encodeFunctionData("disperseEther", [addressToSend, amountToSend]);
        const encodedCal = {
            to: contractInstance.target,
            data: data,
            value: ethers.parseEther('10'),
            gasLimit: 6900000n,
            maxFeePerGas: 3000000000n,
            maxPriorityFeePerGas: 2000000000n,
            nonce: baseNonce + i,
            type: 2,
            chainId: chainId,
        }

        signedTxs.push(await admin.evmWallet.wallet.signTransaction(encodedCal));
    }

    console.log('📤 Sending transactions and capturing block numbers with encoded calls...');
    const results = await Promise.all(
        signedTxs.map(async (signedTx, i) => {
            const hash = await AtomicTxSender.sendRawTransactionWithProvider(
                admin.evmWallet.signingClient,
                signedTx
            );
            await waitFor(0.15);

            const receipt = await admin.evmWallet.signingClient.waitForTransaction(hash);
            console.log(`✅ Tx ${i + 1}/50 - Block ${receipt!.blockNumber}`);
            
            // Get the transaction details to extract the encoded call data
            const tx = await admin.evmWallet.signingClient.getTransaction(hash);
            
            return {
                hash: receipt!.hash,
                blockNumber: Number(receipt!.blockNumber),
                gasUsed: Number(receipt!.gasUsed),
                effectiveGasPrice: Number(receipt!.gasPrice),
                status: receipt!.status,
                encodedCall: tx?.data || '', // Store the encoded call data for replay
                to: tx?.to || '',
                value: tx?.value ? '0x' + tx.value.toString(16) : '0x0' // Store value in hex format
            };
        })
    );

    const uniqueBlocks = Array.from(new Set(results.map(r => r.blockNumber))).sort((a, b) => a - b);
    const gasUsed = results.map(r => r.gasUsed);

    const stats = {
        totalTransactions: results.length,
        successfulTransactions: results.filter(r => r.status === 1).length,
        failedTransactions: results.filter(r => r.status === 0).length,
        blocksWithTransactions: uniqueBlocks.length,
        firstBlock: uniqueBlocks[0],
        lastBlock: uniqueBlocks[uniqueBlocks.length - 1],
        blockRange: uniqueBlocks[uniqueBlocks.length - 1] - uniqueBlocks[0] + 1,
        averageGasUsed: gasUsed.reduce((sum, gas) => sum + gas, 0) / gasUsed.length,
        averageGasPrice: results.reduce((sum, tx) => sum + tx.effectiveGasPrice, 0) / results.length
    };

    const outputData = {
        statistics: stats,
        blocks: uniqueBlocks,
        transactions: results,
        contractAddress: contractInstance.target,
        adminAddress: admin.evmAddress,
        timestamp: new Date().toISOString()
    };

    const outputPath = path.join(__dirname, 'perf_test_blocks.json');
    fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));

    console.log('\n📊 Performance Test Setup Complete!');
    console.log(`📁 Results saved to: ${outputPath}`);
    console.log(`📈 Statistics:`);
    console.log(`   - Total Transactions: ${stats.totalTransactions}`);
    console.log(`   - Successful: ${stats.successfulTransactions}`);
    console.log(`   - Failed: ${stats.failedTransactions}`);
    console.log(`   - Blocks with transactions: ${stats.blocksWithTransactions}`);
    console.log(`   - Block range: ${stats.firstBlock} - ${stats.lastBlock}`);
    console.log(`   - Average gas used: ${stats.averageGasUsed.toFixed(0)}`);
    console.log(`   - Average gas price: ${stats.averageGasPrice.toFixed(0)}`);

    // Export environment variables for k6
    const envVars = {
        K6_BLOCKS: JSON.stringify(uniqueBlocks),
        K6_FIRST_BLOCK: stats.firstBlock,
        K6_LAST_BLOCK: stats.lastBlock,
        K6_BLOCK_COUNT: uniqueBlocks.length,
        K6_CONTRACT_ADDRESS: contractInstance.target,
        K6_ADMIN_ADDRESS: admin.evmAddress,
        K6_RPC_URL: "http://127.0.0.1:8545"
    };

    // Write transaction data to a separate file for eth_call replay
    const transactionDataPath = path.join(__dirname, 'transaction_data.json');
    fs.writeFileSync(transactionDataPath, JSON.stringify(results, null, 2));
    console.log(`📊 Transaction data saved to: ${transactionDataPath}`);

    // Write environment file for k6
    const envPath = path.join(__dirname, 'k6.env');
    const envContent = Object.entries(envVars)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    fs.writeFileSync(envPath, envContent);

    console.log(`🔧 Environment variables saved to: ${envPath}`);
    console.log('\n🚀 Ready to run k6 performance tests!');
    console.log('💡 Will run five performance tests:');
    console.log('   1. debug_traceBlockByNumber - traces blocks');
    console.log('   2. eth_call - replays recorded transactions');
    console.log('   3. debug_traceTransaction - traces individual transactions');
    console.log('   4. eth_getLogs - retrieves logs from blocks');
    console.log('   5. eth_getStorageAt - reads storage from disperse contract');

    console.log("\n📋 Block numbers for debug_traceBlockByNumber:");
    console.log("blocks:", uniqueBlocks);
    console.log("gas:   ", gasUsed);

    console.log('\n🚀 Running k6 performance tests!');
    await runK6();
}

async function runK6() {
    console.log('\n🧪 Running k6 performance tests...');
    
    // Test 1: Debug Trace Performance
    console.log('\n📊 Running debug trace performance test...');
    const debugTraceCommand = `
        set -a
        source k6.env
        set +a
        echo "✅ Exported envs for debug trace:"
        env | grep K6_
        k6 run k6_debug_trace_perf.js
    `;

    const debugTraceChild = spawn("bash", ["-c", debugTraceCommand], {
        stdio: "inherit",
        shell: true,
    });

    const [debugTraceCode] = await once(debugTraceChild, "exit");
    if (debugTraceCode === 0) {
        console.log("✅ Debug trace test finished successfully");
    } else {
        console.error(`❌ Debug trace test exited with code ${debugTraceCode}`);
        process.exit(Number(debugTraceCode) || 1);
    }

    // Test 2: Eth Call Performance (Replay Mode)
    console.log('\n📊 Running eth_call performance test (replay mode)...');
    const ethCallChild = spawn("./run_eth_call.sh", [], {
        stdio: "inherit",
        shell: true,
    });

    const [ethCallCode] = await once(ethCallChild, "exit");
    if (ethCallCode === 0) {
        console.log("✅ Eth call test finished successfully");
    } else {
        console.error(`❌ Eth call test exited with code ${ethCallCode}`);
        process.exit(Number(ethCallCode) || 1);
    }

    // Test 3: Debug Trace Transaction Performance
    console.log('\n📊 Running debug_traceTransaction performance test...');
    const debugTraceTxChild = spawn("./run_debug_trace.sh", [], {
        stdio: "inherit",
        shell: true,
    });

    const [debugTraceTxCode] = await once(debugTraceTxChild, "exit");
    if (debugTraceTxCode === 0) {
        console.log("✅ Debug trace transaction test finished successfully");
    } else {
        console.error(`❌ Debug trace transaction test exited with code ${debugTraceTxCode}`);
        process.exit(Number(debugTraceTxCode) || 1);
    }

    // Test 4: Eth Get Logs Performance
    console.log('\n📊 Running eth_getLogs performance test...');
    const ethGetLogsChild = spawn("./run_eth_get_logs.sh", [], {
        stdio: "inherit",
        shell: true,
    });

    const [ethGetLogsCode] = await once(ethGetLogsChild, "exit");
    if (ethGetLogsCode === 0) {
        console.log("✅ Eth get logs test finished successfully");
    } else {
        console.error(`❌ Eth get logs test exited with code ${ethGetLogsCode}`);
        process.exit(Number(ethGetLogsCode) || 1);
    }

    // Test 5: Eth Get Storage At Performance
    console.log('\n📊 Running eth_getStorageAt performance test...');
    const ethGetStorageAtChild = spawn("./run_eth_get_storage_at.sh", [], {
        stdio: "inherit",
        shell: true,
    });

    const [ethGetStorageAtCode] = await once(ethGetStorageAtChild, "exit");
    if (ethGetStorageAtCode === 0) {
        console.log("✅ Eth get storage at test finished successfully");
    } else {
        console.error(`❌ Eth get storage at test exited with code ${ethGetStorageAtCode}`);
        process.exit(Number(ethGetStorageAtCode) || 1);
    }

    console.log('\n🎉 All k6 performance tests completed successfully!');
    
    // Performance tests completed
    console.log('\n📊 Performance tests completed successfully!');
}



// Run the main function
main().catch(console.error);

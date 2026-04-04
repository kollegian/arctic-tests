import { ethers, Contract } from 'ethers';
import { expect } from 'chai';
import { SeiUser, UserFactory } from '../../shared/User';
import { JSON_PRECOMPILE_ADDRESS } from './constants';
import JSON_ABI from './abis/json_abi.json';

describe('JSON Precompile Tests', function () {
    this.timeout(3 * 60 * 1000);

    let admin: SeiUser;
    let jsonContract: Contract;

    before('Initialize users and contract', async () => {
        admin = await UserFactory.createAdminUser();
        jsonContract = new Contract(JSON_PRECOMPILE_ADDRESS, JSON_ABI, admin.evmWallet.wallet);
    });

    describe('extractAsBytes()', function () {
        it('Extracts a string value from a JSON object', async () => {
            const json = JSON.stringify({ name: 'alice', age: 30 });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytes(input, 'name');
            const decoded = ethers.toUtf8String(result);
            expect(decoded).to.equal('alice');
        });

        it('Extracts a nested object as bytes', async () => {
            const json = JSON.stringify({ user: { name: 'bob' } });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytes(input, 'user');
            const decoded = ethers.toUtf8String(result);
            const parsed = JSON.parse(decoded);
            expect(parsed).to.have.property('name', 'bob');
        });

        it('Extracts a numeric value as bytes', async () => {
            const json = JSON.stringify({ amount: 12345 });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytes(input, 'amount');
            const decoded = ethers.toUtf8String(result);
            expect(decoded).to.equal('12345');
        });

        it('Extracts a boolean value as bytes', async () => {
            const json = JSON.stringify({ active: true });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytes(input, 'active');
            const decoded = ethers.toUtf8String(result);
            expect(decoded).to.equal('true');
        });

        it('Reverts when key does not exist', async () => {
            const json = JSON.stringify({ name: 'alice' });
            const input = ethers.toUtf8Bytes(json);

            try {
                await jsonContract.extractAsBytes(input, 'missing_key');
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });

        it('Reverts with invalid JSON input', async () => {
            const input = ethers.toUtf8Bytes('not valid json');

            try {
                await jsonContract.extractAsBytes(input, 'key');
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });

        it('Handles empty string value', async () => {
            const json = JSON.stringify({ empty: '' });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytes(input, 'empty');
            const decoded = ethers.toUtf8String(result);
            expect(decoded).to.equal('');
        });
    });

    describe('extractAsBytesList()', function () {
        it('Extracts a simple string array', async () => {
            const json = JSON.stringify({ tags: ['red', 'green', 'blue'] });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytesList(input, 'tags');
            expect(result).to.be.an('array');
            expect(result).to.have.lengthOf(3);
            expect(JSON.parse(ethers.toUtf8String(result[0]))).to.equal('red');
            expect(JSON.parse(ethers.toUtf8String(result[1]))).to.equal('green');
            expect(JSON.parse(ethers.toUtf8String(result[2]))).to.equal('blue');
        });

        it('Extracts an array of objects', async () => {
            const json = JSON.stringify({ items: [{ id: 1 }, { id: 2 }] });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytesList(input, 'items');
            expect(result).to.be.an('array');
            expect(result).to.have.lengthOf(2);

            const first = JSON.parse(ethers.toUtf8String(result[0]));
            expect(first).to.have.property('id', 1);
            const second = JSON.parse(ethers.toUtf8String(result[1]));
            expect(second).to.have.property('id', 2);
        });

        it('Returns empty array for empty JSON array', async () => {
            const json = JSON.stringify({ list: [] });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytesList(input, 'list');
            expect(result).to.be.an('array');
            expect(result).to.have.lengthOf(0);
        });

        it('Reverts when key does not point to an array', async () => {
            const json = JSON.stringify({ name: 'alice' });
            const input = ethers.toUtf8Bytes(json);

            try {
                await jsonContract.extractAsBytesList(input, 'name');
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });

    describe('extractAsUint256()', function () {
        it('Extracts a positive integer value', async () => {
            const json = JSON.stringify({ amount: 42 });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsUint256(input, 'amount');
            expect(result).to.equal(42n);
        });

        it('Extracts zero', async () => {
            const json = JSON.stringify({ value: 0 });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsUint256(input, 'value');
            expect(result).to.equal(0n);
        });

        it('Extracts a large number', async () => {
            const largeNum = '1000000000000000000';
            const json = JSON.stringify({ big: Number(largeNum) });
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsUint256(input, 'big');
            expect(result).to.be.a('bigint');
            expect(result > 0n).to.equal(true, `Expected positive bigint, got ${result}`);
        });

        it('Reverts when value is not a number', async () => {
            const json = JSON.stringify({ name: 'alice' });
            const input = ethers.toUtf8Bytes(json);

            try {
                await jsonContract.extractAsUint256(input, 'name');
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });

        it('Reverts when key is missing', async () => {
            const json = JSON.stringify({ amount: 42 });
            const input = ethers.toUtf8Bytes(json);

            try {
                await jsonContract.extractAsUint256(input, 'missing');
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });

    describe('extractAsBytesFromArray()', function () {
        it('Extracts element at index 0 from a JSON array', async () => {
            const json = JSON.stringify(['first', 'second', 'third']);
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytesFromArray(input, 0);
            const decoded = ethers.toUtf8String(result);
            expect(decoded).to.equal('first');
        });

        it('Extracts element at middle index', async () => {
            const json = JSON.stringify(['a', 'b', 'c']);
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytesFromArray(input, 1);
            const decoded = ethers.toUtf8String(result);
            expect(decoded).to.equal('b');
        });

        it('Extracts element at last index', async () => {
            const json = JSON.stringify(['x', 'y', 'z']);
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytesFromArray(input, 2);
            const decoded = ethers.toUtf8String(result);
            expect(decoded).to.equal('z');
        });

        it('Extracts an object element from array', async () => {
            const json = JSON.stringify([{ name: 'alice' }, { name: 'bob' }]);
            const input = ethers.toUtf8Bytes(json);

            const result = await jsonContract.extractAsBytesFromArray(input, 1);
            const decoded = JSON.parse(ethers.toUtf8String(result));
            expect(decoded).to.have.property('name', 'bob');
        });

        it('Reverts when index is out of bounds', async () => {
            const json = JSON.stringify(['only']);
            const input = ethers.toUtf8Bytes(json);

            try {
                await jsonContract.extractAsBytesFromArray(input, 5);
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });

        it('Reverts when input is not a JSON array', async () => {
            const json = JSON.stringify({ key: 'value' });
            const input = ethers.toUtf8Bytes(json);

            try {
                await jsonContract.extractAsBytesFromArray(input, 0);
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });
    });
});

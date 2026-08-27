#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_PATHS="${EEST_TEST_PATHS_FILE:-${REPO_ROOT}/tests/eest/prague-nightly-paths.txt}"
IGNORED_PATHS="${EEST_IGNORED_PATHS_FILE:-${REPO_ROOT}/tests/eest/prague-nightly-ignores.txt}"
REMOTE_EXCLUSIONS="${EEST_REMOTE_EXCLUSIONS_FILE:-${REPO_ROOT}/tests/eest/remote-exclusions.txt}"
EEST_SWEEP_AMOUNT="${EEST_SWEEP_AMOUNT:-100000 ether}"
EEST_PARALLELISM="${EEST_PARALLELISM:-1}"
EEST_SHARD_COUNT="${EEST_SHARD_COUNT:-1}"
EEST_SHARD_INDEX="${EEST_SHARD_INDEX:-0}"
if [[ "${EEST_SHARD_COUNT}" == "1" ]]; then
    EEST_JUNIT_XML="${EEST_JUNIT_XML:-${REPO_ROOT}/eest-report/junit.xml}"
else
    EEST_JUNIT_XML="${EEST_JUNIT_XML:-${REPO_ROOT}/eest-report/junit-shard-${EEST_SHARD_INDEX}.xml}"
fi

export EEST_TEST_TARGET=""
export EEST_JUNIT_XML
export EEST_SWEEP_AMOUNT
export EEST_SHARD_COUNT
export EEST_SHARD_INDEX

execute_options=()
test_paths=()

if [[ ! "${EEST_PARALLELISM}" =~ ^[1-9][0-9]*$ ]]; then
    echo "EEST_PARALLELISM must be a positive integer." >&2
    exit 2
fi
if [[ ! "${EEST_SHARD_COUNT}" =~ ^[1-9][0-9]*$ ]]; then
    echo "EEST_SHARD_COUNT must be a positive integer." >&2
    exit 2
fi
if [[ ! "${EEST_SHARD_INDEX}" =~ ^[0-9]+$ ]] \
    || (( 10#${EEST_SHARD_INDEX} >= 10#${EEST_SHARD_COUNT} )); then
    echo "EEST_SHARD_INDEX must be between 0 and EEST_SHARD_COUNT - 1." >&2
    exit 2
fi

while IFS= read -r test_path; do
    if [[ -n "${test_path}" && ! "${test_path}" =~ ^[[:space:]]*# ]]; then
        test_paths+=("${test_path}")
    fi
done <"${TEST_PATHS}"

if [[ "${EEST_INCLUDE_NON_APPLICABLE:-0}" != "1" ]]; then
    while IFS= read -r ignored_path; do
        if [[ -n "${ignored_path}" && ! "${ignored_path}" =~ ^[[:space:]]*# ]]; then
            execute_options+=(--ignore="${ignored_path}")
        fi
    done <"${IGNORED_PATHS}"
fi

if [[ "${EEST_INCLUDE_REMOTE_EXCLUSIONS:-0}" != "1" ]]; then
    while IFS= read -r test_id; do
        if [[ -n "${test_id}" && ! "${test_id}" =~ ^[[:space:]]*# ]]; then
            execute_options+=(--deselect="${test_id}")
        fi
    done <"${REMOTE_EXCLUSIONS}"
fi
if [[ "${EEST_PARALLELISM}" -gt 1 ]]; then
    execute_options+=(-n="${EEST_PARALLELISM}")
fi
if [[ "${EEST_SHARD_COUNT}" -gt 1 ]]; then
    export PYTHONPATH="${REPO_ROOT}/tests/eest${PYTHONPATH:+:${PYTHONPATH}}"
    execute_options+=(-p eestShard)
fi

exec bash "${REPO_ROOT}/scripts/runEestRemote.sh" \
    "${execute_options[@]}" \
    "${test_paths[@]}" \
    "$@"

#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EEST_REPOSITORY="${EEST_REPOSITORY:-https://github.com/ethereum/execution-specs.git}"
EEST_REVISION="${EEST_REVISION:-2ce2191562f76ec6e64a82f82165d821e1c781fc}"
EEST_DIR="${EEST_DIR:-${REPO_ROOT}/.cache/execution-specs}"
EEST_PATCH="${EEST_PATCH:-${REPO_ROOT}/tests/eest/patches/sei-compat.patch}"
EEST_UV_BIN="${EEST_UV_BIN:-uv}"
EEST_PYTHON="${EEST_PYTHON:-3.12}"

if ! command -v git >/dev/null 2>&1; then
    echo "git is required to install execution-specs." >&2
    exit 2
fi

if ! command -v "${EEST_UV_BIN}" >/dev/null 2>&1; then
    echo "uv is required. Install it from https://docs.astral.sh/uv/." >&2
    exit 2
fi

if [[ ! -f "${EEST_PATCH}" ]]; then
    echo "EEST compatibility patch not found at ${EEST_PATCH}." >&2
    exit 2
fi

if [[ ! -d "${EEST_DIR}/.git" ]]; then
    if [[ -e "${EEST_DIR}" ]]; then
        echo "${EEST_DIR} exists but is not an execution-specs git checkout." >&2
        exit 2
    fi
    mkdir -p "$(dirname "${EEST_DIR}")"
    git init --quiet "${EEST_DIR}"
    git -C "${EEST_DIR}" remote add origin "${EEST_REPOSITORY}"
fi

current_revision="$(git -C "${EEST_DIR}" rev-parse HEAD 2>/dev/null || true)"
if [[ "${current_revision}" != "${EEST_REVISION}" ]]; then
    if [[ -n "$(git -C "${EEST_DIR}" status --short 2>/dev/null)" ]]; then
        echo "Refusing to replace modified EEST checkout at ${EEST_DIR}." >&2
        exit 2
    fi
    git -C "${EEST_DIR}" fetch --depth 1 origin "${EEST_REVISION}"
    git -C "${EEST_DIR}" checkout --quiet --detach FETCH_HEAD
fi

if git -C "${EEST_DIR}" apply --check "${EEST_PATCH}" >/dev/null 2>&1; then
    git -C "${EEST_DIR}" apply "${EEST_PATCH}"
elif ! git -C "${EEST_DIR}" apply --reverse --check "${EEST_PATCH}" \
    >/dev/null 2>&1; then
    echo "EEST compatibility patch does not apply to ${EEST_REVISION}." >&2
    exit 2
fi

"${EEST_UV_BIN}" sync \
    --directory "${EEST_DIR}" \
    --frozen \
    --no-dev \
    --package ethereum-execution-testing \
    --python "${EEST_PYTHON}"

printf '%s\n' "${EEST_REVISION}" >"${EEST_DIR}/.arctic-eest-revision"
echo "Installed patched execution-specs ${EEST_REVISION} in ${EEST_DIR}."

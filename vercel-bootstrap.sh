#!/usr/bin/env bash
# Vercel のビルド時に実行：非公開の GitHub リポジトリ（読み取り専用キー）からソースを取得してビルドする
set -euo pipefail
HERE="$(pwd)"
mkdir -p ~/.ssh
printf '%s' "$NPAS_DEPLOY_KEY_B64" | base64 -d > ~/.ssh/npas_key
chmod 600 ~/.ssh/npas_key
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/npas_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
rm -rf /tmp/npas-src
git clone --depth 1 --branch "${NPAS_REF:-main}" "git@github.com:${NPAS_REPO}.git" /tmp/npas-src
cd /tmp/npas-src
git log -1 --format='ビルドするコミット: %h %s'
node tools/build-vercel.mjs
rm -rf "$HERE/.vercel/output"
mkdir -p "$HERE/.vercel"
cp -r .vercel/output "$HERE/.vercel/output"

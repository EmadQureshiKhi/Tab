#!/usr/bin/env bash
#
# Applies the queued curation change for tab.proof-service (task 12.5).
#
# The change was queued on 2026-09-06 08:40:45 UTC behind the registry's 48-hour
# hold, so `ServiceRegistry.applyChange` reverts with `TimelockPending` until
# 2026-09-08 08:40:45 UTC. That is not advisory: the contract reads
# `block.timestamp` and refuses, so running this early costs gas and changes
# nothing.
#
# It simulates first and stops on a revert, because on this chain an exhausted
# gas limit and a revert look identical after the fact, and the simulation is the
# only cheap way to tell them apart beforehand.
#
#   node --env-file=.env scripts/... is not used here: this is cast, not node.
#   set -a; . <(sed '1s/^\xEF\xBB\xBF//' .env | tr -d '\r'); set +a; bash scripts/apply-curation.sh
#
set -euo pipefail

RPC="${CREDITCOIN_RPC_URL:?CREDITCOIN_RPC_URL must be set}"
REGISTRY="${SERVICE_REGISTRY_ADDRESS:?SERVICE_REGISTRY_ADDRESS must be set}"
KEY="${CURATION_AUTHORITY_PRIVATE_KEY:?CURATION_AUTHORITY_PRIVATE_KEY must be set}"
CHANGE_ID="0xad88e0f1487410963657c1ae2f09ef3f8baf4266b5535a0a7c903ce79b7cebd5"

FROM="$(cast wallet address --private-key "$KEY")"
echo "registry   $REGISTRY"
echo "change     $CHANGE_ID"
echo "authority  $FROM"

# The chain's clock, not this machine's. A host clock that disagreed would either
# waste gas or refuse a change that was already applicable.
NOW="$(cast block latest --rpc-url "$RPC" --field timestamp)"
# The fourth field of the tuple. A regex over the whole line matched a run of
# digits inside the serviceId's hex instead, and reported ninety million minutes
# remaining, so the field is taken by position.
ETA="$(cast call "$REGISTRY" "pendingChangeOf(bytes32)((bytes32,uint8,bytes,uint64,bool))" "$CHANGE_ID" --rpc-url "$RPC" \
  | tr -d '()' | cut -d, -f4 | grep -oE '[0-9]+' | head -1)"
echo "chain time $NOW"
echo "eta        $ETA"
if [ "$NOW" -lt "$ETA" ]; then
  echo "not yet: $(( (ETA - NOW) / 60 )) minutes remain on the hold." >&2
  exit 1
fi

echo "simulating..."
cast call "$REGISTRY" "applyChange(bytes32)" "$CHANGE_ID" --from "$FROM" --rpc-url "$RPC" >/dev/null
echo "simulation passed."

# Gas stated explicitly. An estimate comes from a warm simulation and
# underestimates the cold writes this makes, and an exhausted limit is
# indistinguishable from a revert in the receipt.
cast send "$REGISTRY" "applyChange(bytes32)" "$CHANGE_ID" \
  --private-key "$KEY" --rpc-url "$RPC" --gas-limit 500000

echo
echo "tier now:"
cast call "$REGISTRY" "tierOf(bytes32)(uint8)" \
  "0x7461622e70726f6f662d73657276696365000000000000000000000000000000" --rpc-url "$RPC"
echo "(0 is Permissionless, 1 is Curated)"

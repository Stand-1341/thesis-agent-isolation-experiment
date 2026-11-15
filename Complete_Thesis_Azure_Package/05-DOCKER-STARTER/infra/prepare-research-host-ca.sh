#!/usr/bin/env bash
# Operator-side first step. Generate the public CA that workload images trust
# and a matching private key that must be kept outside the repository.
set -euo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  echo 'Usage: prepare-research-host-ca.sh PUBLIC_CA_OUTPUT_OUTSIDE_REPOSITORY PRIVATE_KEY_OUTPUT_OUTSIDE_REPOSITORY' >&2
  exit 2
fi
public_out=$1
private_out=$2
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)
[[ -n $repo_root ]] || { echo 'Run from a Git checkout so the private-key destination can be checked.' >&2; exit 1; }
repo_root=$(realpath "$repo_root")
private_parent=$(dirname "$private_out")
public_parent=$(dirname "$public_out")
[[ -d $private_parent && -d $public_parent ]] || { echo 'Both output directories must already exist.' >&2; exit 1; }
private_parent=$(realpath "$private_parent")
public_parent=$(realpath "$public_parent")
for output_path in "$private_parent/$(basename "$private_out")" "$public_parent/$(basename "$public_out")"; do
  case "$output_path" in
    "$repo_root"|"$repo_root"/*) echo 'Both CA output files must be outside the repository.' >&2; exit 1;;
  esac
done
[[ "$private_parent/$(basename "$private_out")" != "$public_parent/$(basename "$public_out")" ]] || {
  echo 'Public certificate and private key need separate output paths.' >&2; exit 1;
}
[[ ! -e $private_out && ! -L $private_out && ! -e $public_out && ! -L $public_out ]] || {
  echo 'Output already exists; refusing to overwrite CA material.' >&2; exit 1;
}
command -v openssl >/dev/null 2>&1 || { echo 'openssl is required.' >&2; exit 1; }

staging=$(mktemp -d)
chmod 700 "$staging"
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$staging/ca.key" >/dev/null 2>&1
openssl req -x509 -new -key "$staging/ca.key" -sha256 -days 3650 \
  -subj '/CN=Thesis pilot CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -out "$staging/ca.crt"
openssl x509 -in "$staging/ca.crt" -noout -checkend 31536000 >/dev/null
openssl verify -CAfile "$staging/ca.crt" "$staging/ca.crt" >/dev/null
install -m 0600 "$staging/ca.key" "$private_out"
if ! install -m 0644 "$staging/ca.crt" "$public_out"; then rm -f "$private_out"; exit 1; fi
cmp <(openssl pkey -in "$private_out" -pubout 2>/dev/null) <(openssl x509 -in "$public_out" -pubkey -noout)
echo 'Research-host CA is ready. Public certificate written; private key remains in the protected external file.'
echo "Private-key path: $private_out"
echo "Public certificate path: $public_out"

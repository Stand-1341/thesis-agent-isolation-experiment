#!/usr/bin/env bash
# First-time private TLS setup for the three research-host listeners. Run as
# root after installing the matching CA key from Key Vault and staging the
# public CA certificate that was bundled into the workload image.
set -euo pipefail
umask 077

if [[ $(id -u) -ne 0 || $# -ne 3 ]]; then
  echo 'Usage: bootstrap-research-host-tls.sh RESEARCH_IP COLLECTOR_IP RESTRICTED_IP' >&2
  exit 2
fi

research_ip=$1
collector_ip=$2
restricted_ip=$3
tls_dir=${TLS_DIR:-/etc/thesis-research/tls}
site_available=${NGINX_SITES_AVAILABLE:-/etc/nginx/sites-available}
site_enabled=${NGINX_SITES_ENABLED:-/etc/nginx/sites-enabled}
template=${RESEARCH_PROXY_TEMPLATE:-/opt/thesis-research/research-proxy.nginx.template}
site_name=thesis-research
site_path="$site_available/$site_name"
enabled_path="$site_enabled/$site_name"

private_ipv4() {
  local value=$1 a b c d octet
  [[ $value =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  IFS=. read -r a b c d <<< "$value"
  for octet in "$a" "$b" "$c" "$d"; do ((10#$octet <= 255)) || return 1; done
  ((10#$a == 10 || (10#$a == 172 && 10#$b >= 16 && 10#$b <= 31) || (10#$a == 192 && 10#$b == 168)))
}

for ip in "$research_ip" "$collector_ip" "$restricted_ip"; do
  private_ipv4 "$ip" || { echo 'All three listener addresses must be private IPv4 addresses.' >&2; exit 2; }
done
[[ $(printf '%s\n' "$research_ip" "$collector_ip" "$restricted_ip" | sort -u | wc -l) -eq 3 ]] || {
  echo 'The three listener addresses must be distinct.' >&2; exit 2;
}
for tool in openssl nginx; do command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required." >&2; exit 1; }; done
[[ -f $template && ! -L $template ]] || { echo 'Research proxy template is missing or unsafe.' >&2; exit 1; }
[[ -d $tls_dir && ! -L $tls_dir && -f $tls_dir/ca.key && ! -L $tls_dir/ca.key && -f $tls_dir/ca.crt && ! -L $tls_dir/ca.crt ]] || {
  echo 'Root-only CA key and bundled public CA certificate must be installed first.' >&2; exit 1;
}
[[ ! -e $tls_dir/research.key && ! -e $tls_dir/collector.key && ! -e $tls_dir/restricted.key &&
   ! -e $site_path && ! -L $site_path && ! -e $enabled_path && ! -L $enabled_path ]] || {
  echo 'A listener certificate or nginx site already exists; refusing to overwrite it.' >&2; exit 1;
}
[[ -d $site_available && -d $site_enabled ]] || { echo 'nginx site directories must exist.' >&2; exit 1; }
[[ $(stat -c '%u:%a' "$tls_dir/ca.key") == '0:600' ]] || { echo 'CA private key must be root-owned with mode 600.' >&2; exit 1; }
openssl x509 -in "$tls_dir/ca.crt" -noout -checkend 2592000 >/dev/null || { echo 'Bundled CA certificate expires too soon.' >&2; exit 1; }
grep -q 'BEGIN CERTIFICATE' "$tls_dir/ca.crt" || { echo 'Bundled CA certificate is invalid.' >&2; exit 1; }
openssl verify -CAfile "$tls_dir/ca.crt" "$tls_dir/ca.crt" >/dev/null || { echo 'Bundled CA certificate is not a valid trust anchor.' >&2; exit 1; }
cmp <(openssl pkey -in "$tls_dir/ca.key" -pubout 2>/dev/null) <(openssl x509 -in "$tls_dir/ca.crt" -pubkey -noout) || {
  echo 'Key Vault CA private key does not match the image trust certificate.' >&2; exit 1;
}

staging=$(mktemp -d)
chmod 700 "$staging"
cp "$tls_dir/ca.crt" "$staging/ca.crt"
installed=0
cleanup() { rm -rf "$staging"; }
rollback() {
  rm -f "$enabled_path" "$site_path"
  rm -f "$tls_dir/research.key" "$tls_dir/research.crt" "$tls_dir/collector.key" "$tls_dir/collector.crt" \
    "$tls_dir/restricted.key" "$tls_dir/restricted.crt"
}
on_exit() {
  status=$?
  if [[ $status -ne 0 && $installed -eq 1 ]]; then rollback; fi
  cleanup
  return "$status"
}
trap on_exit EXIT

# Issue three IP-SAN server certificates under the exact CA bundled into the
# workload image. Leaf private keys remain root-only on this host.
issue_server() {
  local name=$1 ip=$2
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$staging/$name.key" >/dev/null 2>&1
  openssl req -new -key "$staging/$name.key" -subj "/CN=$name" -out "$staging/$name.csr"
  cat > "$staging/$name.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$ip
EOF
  openssl x509 -req -in "$staging/$name.csr" -CA "$tls_dir/ca.crt" -CAkey "$tls_dir/ca.key" \
    -CAserial "$staging/ca.srl" -CAcreateserial -out "$staging/$name.crt" -days 365 -sha256 \
    -extfile "$staging/$name.ext" >/dev/null 2>&1
  openssl verify -CAfile "$staging/ca.crt" -verify_ip "$ip" "$staging/$name.crt" >/dev/null
}
issue_server research "$research_ip"
issue_server collector "$collector_ip"
issue_server restricted "$restricted_ip"

rendered="$staging/$site_name.conf"
for pair in "__RESEARCH_PRIVATE_IP__=$research_ip" "__COLLECTOR_PRIVATE_IP__=$collector_ip" "__RESTRICTED_PRIVATE_IP__=$restricted_ip"; do
  placeholder=${pair%%=*}; address=${pair#*=}
  count=$(grep -F -o "$placeholder" "$template" | wc -l)
  [[ $count -eq 1 ]] || { echo "Invalid proxy template placeholder: $placeholder" >&2; exit 1; }
  if [[ ! -e $rendered ]]; then cp "$template" "$rendered"; fi
  sed -i "s/$placeholder/$address/" "$rendered"
done
if grep -Eq '__[A-Z_]+__' "$rendered"; then echo 'Unresolved proxy template placeholder.' >&2; exit 1; fi

installed=1
for name in research collector restricted; do
  install -o root -g root -m 0600 "$staging/$name.key" "$tls_dir/$name.key"
  install -o root -g root -m 0644 "$staging/$name.crt" "$tls_dir/$name.crt"
done
install -o root -g root -m 0644 "$rendered" "$site_path"
ln -s "$site_path" "$enabled_path"
if ! nginx -t; then echo 'nginx validation failed; newly generated TLS material and site config will be removed.' >&2; exit 1; fi
installed=0

echo 'Private listener TLS is staged and nginx syntax validated. No service was started or reloaded.'
echo "CA certificate: $tls_dir/ca.crt"
echo "Listener SANs verified: research=$research_ip collector=$collector_ip restricted=$restricted_ip"

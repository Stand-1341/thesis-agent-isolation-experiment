#!/bin/sh
# Candidate staging only. No disk formatting, secrets, TLS, systemctl or startup.
set -eu
if [ "$(id -u)" -ne 0 ] || [ "$#" -ne 5 ]; then
  echo 'Usage: stage-research-host.sh PACKAGE NODE22 MANIFEST_SHA256 TRUSTED_VERIFIER VERIFIER_SHA256' >&2; exit 2
fi
package=$1; node_binary=$2; manifest_digest=$3; verifier=$4; verifier_digest=$5
case "$manifest_digest" in *[!a-f0-9]*|'') echo 'Invalid manifest digest' >&2; exit 1;; esac
case "$verifier_digest" in *[!a-f0-9]*|'') echo 'Invalid verifier digest' >&2; exit 1;; esac
[ "${#manifest_digest}" -eq 64 ] && [ "${#verifier_digest}" -eq 64 ] || { echo 'Invalid digest length' >&2; exit 1; }
[ -f "$node_binary" ] && [ -x "$node_binary" ] && [ -f "$verifier" ] || { echo 'Runtime or verifier missing' >&2; exit 1; }
node_sha256='94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90'
[ "$(sha256sum "$node_binary" | cut -d ' ' -f 1)" = "$node_sha256" ] || { echo 'Node checksum mismatch' >&2; exit 1; }
[ "$(sha256sum "$verifier" | cut -d ' ' -f 1)" = "$verifier_digest" ] || { echo 'Verifier checksum mismatch' >&2; exit 1; }
"$node_binary" "$verifier" "$package" "$manifest_digest"
for target in /opt/thesis-research /opt/thesis-runtime/node /etc/thesis-research /etc/systemd/system/thesis-research.service /etc/systemd/system/thesis-collector.service; do
  [ ! -e "$target" ] && [ ! -L "$target" ] || { echo 'Existing installation requires manual reconciliation' >&2; exit 1; }
done
for user in thesis-research thesis-collector; do
  if getent passwd "$user" >/dev/null || getent group "$user" >/dev/null; then echo 'Existing service identity requires manual reconciliation' >&2; exit 1; fi
done
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin thesis-research
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin thesis-collector
install -d -o root -g root -m 0755 /opt/thesis-research/dist /opt/thesis-runtime/node/bin
install -d -o root -g root -m 0700 /etc/thesis-research
for name in resource.js collector.js resource-journal.js collector-journal.js service-config.js helpers.js; do
  install -o root -g root -m 0644 "$package/dist/$name" "/opt/thesis-research/dist/$name"
done
install -o root -g root -m 0644 "$package/package.json" /opt/thesis-research/package.json
install -o root -g root -m 0755 "$package/check-research-data-disk.sh" /opt/thesis-research/check-research-data-disk.sh
install -o root -g root -m 0644 "$package/research-proxy.nginx.template" /opt/thesis-research/research-proxy.nginx.template
install -o root -g root -m 0755 "$node_binary" /opt/thesis-runtime/node/bin/node
install -o root -g root -m 0644 "$package/research-service.service" /etc/systemd/system/thesis-research.service
install -o root -g root -m 0644 "$package/collector-service.service" /etc/systemd/system/thesis-collector.service
echo 'Research files staged. No service was enabled or started.'

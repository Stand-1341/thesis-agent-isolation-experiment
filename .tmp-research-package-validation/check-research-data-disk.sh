#!/bin/sh
# Read-only preflight for a single directly formatted Azure LUN 0 disk.
# It does not partition, format, mount, change permissions, or prove immutability.
set -eu
if [ "$#" -ne 0 ]; then echo 'Run with no arguments.' >&2; exit 2; fi
mountpoint=/srv/thesis-data
device=/dev/disk/azure/data/by-lun/0
if [ ! -b "$device" ]; then device=/dev/disk/azure/scsi1/lun0; fi
[ -b "$device" ] || { echo 'Expected Azure LUN 0 block device is absent.' >&2; exit 1; }
mountpoint -q "$mountpoint" || { echo 'Research data mount is absent.' >&2; exit 1; }
actual=$(findmnt -n -o MAJ:MIN --mountpoint "$mountpoint")
expected=$(lsblk -dn -o MAJ:MIN "$device")
[ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo 'Research mount is not the expected direct LUN 0 filesystem.' >&2; exit 1; }
for directory in "$mountpoint/resource" "$mountpoint/collector"; do
  [ -d "$directory" ] && [ ! -L "$directory" ] || { echo 'Required journal directory is missing or a symlink.' >&2; exit 1; }
done
echo 'Candidate data mount matches direct Azure LUN 0; audit independence remains unverified.'

# Changelog

All notable changes to this plugin are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [1.3.0]

- Fix handling of node-ble 128-bit UUIDs
- Fix encrypted reads for Elite v2 BLE
  - Confirmed successful values read from an Elite 100 V2
- CLI now has separate `dump` and `info` commands for raw and interpreted data

## [1.2.0]

- Stop scanner going into continuous scan loop if configured device not found
- Add discovery timeout
- Added CLI to scan and inspect devices
- Build tools added oxfmt and oxlint to improve cod quality
- Fix upstream EventEmitter leak in `@naugehyde/node-ble`

## [1.1.2-alpha]

- Fix crash on scan completion

## [1.1.1-alpha]

- Add timeout handling for BLE connect/polling

## [1.1.0-alpha]

- Switch BLE backend from `@stoprocent/noble` to `@naugehyde/node-ble` (BlueZ D-Bus), so connections persist across disconnects without needing a rescan

## [1.0.8-alpha]

- Improve connect/reconnect behaviour

## [1.0.7-alpha]

- Validate the encryption key file; stop scanning once a device connection starts

## [1.0.6-alpha] and earlier

- Initial register map support, BLE scanning, and encryption-key auto-detection, plus assorted fixes leading up to the first alpha releases

## [1.0.0]

- Initial release

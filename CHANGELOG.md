# Changelog

All notable changes to this plugin are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]
- Add discovery timeout

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
